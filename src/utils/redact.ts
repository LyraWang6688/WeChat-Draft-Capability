/**
 * 敏感键名。刻意写成「不含捕获组的字符串」，供两处共享：
 *   - 标量键名匹配（SENSITIVE_KEY_PATTERN）
 *   - 文本内 key=value 脱敏（SECRET_IN_TEXT_PATTERN）
 * 之前 SENSITIVE_KEY_PATTERN 自带捕获组，被嵌入另一个正则后会让整体捕获组数量+1，
 * 导致 replace 回调参数右移，把键名当成值来脱敏。
 */
const SENSITIVE_KEY_SOURCE =
  "secret|token|authorization|cookie|password|device_code|access_token|refresh_token|user_access_token|appSecret|app_secret|baseToken|base_token";

/** 用于判定「某个对象的键名是否敏感」 */
const SENSITIVE_KEY_PATTERN = new RegExp(`(?:${SENSITIVE_KEY_SOURCE})`, "i");

/**
 * 敏感键名 + 值 的形态，用于脱敏 URL query、header 与 key=value 文本。
 *
 * 值的边界：遇到 URL 分隔符（& # ? /）、空白、引号、逗号、分号即结束，
 * 避免把后续无关内容一起吃进来，也避免只遮住值的一部分。
 */
const SECRET_IN_TEXT_PATTERN = new RegExp(
  `(?:${SENSITIVE_KEY_SOURCE})\\s*[=:]\\s*([^&#?/\\s,;"']+)`,
  "gi"
);

/** 只在「值看起来确实像密钥」时才脱敏，避免误伤 tokenizer 之类的普通词。 */
function isSecretLike(value: string) {
  return value.length >= 8;
}

/** key=value 形态的保护性脱敏；保留键名与结构，只遮值。 */
export function redactText(value: string) {
  return value.replace(SECRET_IN_TEXT_PATTERN, (match: string, secret: string) => {
    if (typeof secret !== "string" || !isSecretLike(secret)) {
      return match;
    }
    const masked = secret.length <= 8 ? "***" : `${secret.slice(0, 4)}***${secret.slice(-4)}`;
    return match.replace(secret, masked);
  });
}

export function maskValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  if (value.length <= 8) {
    return "***";
  }

  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

export function truncateText(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}...<truncated ${value.length - maxChars} chars>`;
}

export function redactValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item)) as T;
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    Object.entries(value as Record<string, unknown>).forEach(([key, rawValue]) => {
      result[key] = SENSITIVE_KEY_PATTERN.test(key) ? maskValue(rawValue) : redactValue(rawValue);
    });
    return result as T;
  }

  if (typeof value === "string") {
    return redactText(value) as T;
  }

  return value;
}

export function redactArgs(args: string[]) {
  return args.map((arg, index) => {
    const prev = args[index - 1] || "";
    if (SENSITIVE_KEY_PATTERN.test(prev)) {
      return typeof maskValue(arg) === "string" ? (maskValue(arg) as string) : "***";
    }

    return redactText(arg);
  });
}
