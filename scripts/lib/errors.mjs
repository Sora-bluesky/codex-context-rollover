export class RolloverError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "RolloverError";
    this.code = code;
  }
}

export function asErrorCategory(error) {
  if (error instanceof RolloverError) {
    return error.code;
  }
  return "unexpected_error";
}
