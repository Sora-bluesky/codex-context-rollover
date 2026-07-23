import { createHash } from "node:crypto";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function descriptorHash(descriptor) {
  return sha256(stableJson(descriptor));
}
