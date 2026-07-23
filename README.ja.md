# 🔄 Codex Context Rollover

[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933.svg)](package.json)
[![検証](https://img.shields.io/badge/validation-51%20tests%20passing-brightgreen.svg)](docs/evidence.md)
[![状態](https://img.shields.io/badge/status-experimental-orange.svg)](#現在の状態)

**🌐 Language: [English](README.md) | 日本語**

---

**Codex Context Rollover**は、コンテキストを使い切る前に、進行中のCodexタスクを新しい後継タスクへ移すプラグインです。処理の節目を永続化し、途中で止まっても安全な状態を残します。

対象のプロジェクト、引き継ぎファイル、CI実行、タスクを推測しません。確認済みのプロバイダーを設定するまで、実Codexタスクの作成や実CI監視の開始も行いません。

---

## ✨ これは何？

長時間動かしたCodexタスクは、いずれコンテキスト上限へ近づきます。単純に新しいタスクを作るだけでは、作業状況が抜けたり、後継タスクが重複したり、CI監視の担当が一時的にゼロになったりします。

このプラグインは、ロールオーバーを所有権の移管として扱います。

```text
Codex Stopフック
      │
      ▼
使用中コンテキストを計測 ── 閾値未満 ──▶ 何も出力せず終了
      │
      ▼ 閾値に到達
Requestedを永続化
      │
      ▼
明示された引き継ぎファイルを検証
      │
      ▼
後継CI監視を開始 ── 最初の成功観測を待つ
      │
      ▼
CreatingThreadを永続化 ── 後継タスクを1回だけ作成
      │
      ├── 応答が不明 ──▶ 推測で再試行せずReconcileへ
      ▼
後継IDを永続化 ── 旧タスクへ案内 ── 旧監視を停止
```

旧タスクを自動でアーカイブしたり削除したりすることはありません。

---

## 🛡️ 安全条件

| 条件 | 動作 |
|------|------|
| 対象を明示 | プロジェクトroot、引き継ぎパス、閾値、監視対象は設定から取得 |
| 現在量で判定 | 累積使用量ではなく、現在使っているコンテキスト量で判定 |
| 所有者は1つ | タスク単位のリースで同時実行を防止 |
| 引き継ぎを検証 | プロジェクト内の同一ファイルが更新され、必須見出しを保ったことを確認 |
| 監視の空白なし | 後継監視が同じ固定対象を観測するまで旧監視を維持 |
| 後継を重複させない | `thread/start`の結果が不明なら、自動再試行せず照合へ移行 |
| 順序を永続化 | 外部操作の前後に、復旧に必要な状態を保存 |
| 保存情報を限定 | 不透明ID、ハッシュ、時刻、処理段階、秘匿化したエラー分類だけを保存 |
| 安全側で停止 | 入力が不足・曖昧なら、外部変更を行わず`needs decision`を返す |

---

## 🎯 想定する利用者

- 長時間のCodexタスクを、コンテキスト枯渇前に安全に引き継ぎたい
- 移管中もCI監視の担当を切らしたくない
- 失敗時に別タスクを黙って作らず、確認できる状態で止めたい
- 実サービスへ接続する前に、プロジェクト固有プロバイダーの安全条件をテストしたい

---

## 📋 必要な環境

| 必要なもの | 確認方法 | 補足 |
|------------|----------|------|
| Node.js 20以上 | `node --version` | Node.js標準モジュールと`node:test`を使用 |
| npm | `npm --version` | リポジトリ内のコマンド実行にだけ使用 |
| Codex CLI | `codex --version` | Codexと接続する場合に必要 |
| Python 3 | `python --version` | 任意。プラグイン検証に使用 |

外部npmパッケージへの依存はありません。

---

## 🚀 クイックスタート

### cloneして合成データの検証を実行

```powershell
git clone https://github.com/Sora-bluesky/codex-context-rollover.git
Set-Location codex-context-rollover
npm test
npm run dry-run
```

乾式実行は合成データだけで一連の移管を行い、次の結果を返します。

```text
status: complete
realCodexThreadsCreated: 0
realCiWatchersStarted: 0
globalConfigurationChanges: 0
minimumWatcherOwners: 1
```

### 設定例を確認

[`examples/config.example.json`](examples/config.example.json)を参照してください。実際の設定では、次の対象を明示します。

- プロジェクトrootの絶対パス
- プラグイン用データディレクトリ
- プロジェクトからの相対パスで指定した引き継ぎファイル1つ
- 引き継ぎファイルの必須見出し
- 残量率と残トークン数の閾値
- 既定値を変える場合は、監視確認と取消確認のタイムアウト

実Codexと実CIのプロバイダーは同梱していません。接続は別途レビューを行ったうえで導入します。

---

## ⚙️ 処理の流れ

### 1. 使用中コンテキストを計測

優先する情報源は、コントローラーが管理するCodex app-serverの`thread/tokenUsage/updated`です。互換アダプターは、Stopフックから渡された正確な`transcript_path`だけを読み、末尾の限られた範囲から、現在対応している`event_msg/token_count`を探します。

未知の形式や壊れたデータを見つけた場合、ロールオーバーは行いません。

### 2. 要求を永続化

Stopフックは`Requested`を保存してから`decision: block`を返します。同じStopイベントが繰り返されても新しい要求は作らず、`stop_hook_active`で継続処理のループを防ぎます。

### 3. 引き継ぎファイルを検証

設定されたプロジェクト内のファイルを1つだけ解決し、確認済みのファイルハンドルから読み取ります。更新後は、同じ単一リンクのファイルが変更され、必須見出しをすべて保っていることを確認します。

### 4. CI監視を移管

後継監視は、旧監視と同じ固定対象を観測し、最初の成功を返す必要があります。タイムアウト時は、後継監視の取消を確認できた場合だけ通常の失敗として扱います。取消結果が不明なら`NeedsDecision`へ移り、旧監視を残します。

### 5. 後継タスクを作成または照合

作成要求の前に`CreatingThread`を保存します。正常な後継IDは、旧タスクへ案内を送る前に永続化します。応答が消失または不正だった場合は`Reconcile`へ移り、明示した条件に一致する候補が1件だけある場合に採用します。

---

## 📏 コンテキスト量の計算

使用中コンテキストは、`last.totalTokens`または`last_token_usage.total_tokens`です。累積使用量は別項目として扱い、閾値判定には使いません。

残量率はCodexの表示基準に合わせます。

```text
実効残量率 =
  max(モデルのコンテキスト上限 - 使用中トークン数 - 12,000, 0)
  / max(モデルのコンテキスト上限 - 12,000, 1)
  × 100
```

残量率と残トークン数の閾値は、どちらも設定で明示します。

---

## 📁 リポジトリ構成

```text
codex-context-rollover/
├── .codex-plugin/             # プラグインmanifest
├── hooks/                     # Stopフック
├── skills/                    # 継続処理と状態確認
├── scripts/
│   ├── adapters/              # Codex、transcript、引き継ぎ、CI、タスクの境界
│   ├── controller/            # ロールオーバーの制御
│   ├── domain/                # コンテキスト計算と状態機械
│   ├── state/                 # 原子的な状態保存とタスク単位のリース
│   └── synthetic/             # 外部変更を行わないプロバイダーと乾式実行
├── test/
│   ├── unit/                  # 境界値と安全条件のテスト
│   └── e2e/                   # 合成データによる一連の移管テスト
├── docs/
│   ├── design.md              # 構成と安全条件
│   ├── acceptance.md          # 受入条件
│   └── evidence.md            # プロトコルと検証証跡
└── CONTRIBUTING.md            # 公開用の開発・安全規約
```

作業者用メモとローカルのエージェント設定はGitの追跡対象外です。

---

## ✅ 検証

ローカルの検証をすべて実行します。

```powershell
npm run test:unit
npm run test:e2e
npm run dry-run
$validator = Join-Path $env:USERPROFILE '.codex\skills\.system\plugin-creator\scripts\validate_plugin.py'
python $validator '.'
```

現在確認できている結果です。

| 検証 | 結果 |
|------|------|
| 単体テスト | 50件成功 |
| 合成データによる一連の移管テスト | 1件成功 |
| 全テスト | 51件成功、失敗0件 |
| 乾式実行 | 完了 |
| 実Codexタスクの作成 | 0件 |
| 実CI監視の開始 | 0件 |
| グローバル設定の変更 | 0件 |
| プラグイン検証 | 合格 |

---

## ⚠️ 現在の状態

状態機械、Stopフック、継続処理、状態確認、合成プロバイダー、受入テストまで実装済みです。

次の機能は含まれていません。

- 認証済みの実Codexタスク用プロバイダー
- 実CI用プロバイダー
- プラグインの自動導入や信頼設定
- 時刻の新しさによるプロジェクト、引き継ぎファイル、タスク、CIの推測
- 旧タスクの自動アーカイブや削除

導入と実プロバイダーの接続には、セキュリティと切り戻し方法のレビューが別途必要です。

---

## ❓ よくある質問

<details>
<summary><strong>乾式実行で実Codexタスクは作られますか？</strong></summary>

作られません。記録用の合成プロバイダーを使い、実Codexタスク、実CI監視、グローバル設定変更がすべて0件であることを確認します。

</details>

<details>
<summary><strong>応答が消えたとき、なぜタスク作成を再試行しないのですか？</strong></summary>

応答を受け取れなくても、タスク自体は作られている可能性があります。再試行すると重複するため、`Reconcile`を記録し、明示した条件の範囲で候補を照合します。

</details>

<details>
<summary><strong>旧監視を長く残す理由は？</strong></summary>

早く止めると、監視の担当がゼロになる時間が生じます。後継が監視対象を確認し、後継タスクIDを保存し、旧タスクへの案内が終わるまで旧監視を残します。

</details>

<details>
<summary><strong>現在のタスクを自動で見つけられますか？</strong></summary>

見つけません。時刻の新しさはタスクの識別情報にならないためです。タスク、プロジェクト、引き継ぎ、CIの情報が不足していれば`needs decision`を返します。

</details>

---

## 🤝 コントリビューション

安全条件を変更する前に[`CONTRIBUTING.md`](CONTRIBUTING.md)を確認してください。テストには合成データだけを使い、受入条件を弱めたりスキップしたりして通す変更は受け付けません。

不具合報告や提案は[GitHub Issues](https://github.com/Sora-bluesky/codex-context-rollover/issues)へお願いします。

---

## 🔗 ドキュメント

- [構成と安全条件](docs/design.md)
- [受入条件](docs/acceptance.md)
- [プロトコルと検証証跡](docs/evidence.md)
- [設定例](examples/config.example.json)
- [OpenAI Codex](https://github.com/openai/codex)

---

📅 **最終更新:** 2026年7月24日
