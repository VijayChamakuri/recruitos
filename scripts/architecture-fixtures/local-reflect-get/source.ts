const Reflect = {
  get(value: { label: string }, key: "label") {
    return value[key];
  }
};

export const label = Reflect.get({ label: "ok" }, "label");
