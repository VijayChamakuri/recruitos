const R = Reflect;
const Constructor = R.get(() => "ok", "constructor");

export const host = Constructor("return globalThis")();
