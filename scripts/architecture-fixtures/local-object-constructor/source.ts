class LocalValue {}

const value = new LocalValue();

export const localConstructor = value.constructor;
