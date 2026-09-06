const { get: readProperty } = Reflect;
const Constructor = readProperty(() => "ok", "constructor");

export const host = Constructor("return globalThis")();
