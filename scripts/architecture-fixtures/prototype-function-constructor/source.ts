const functionPrototype = Object.getPrototypeOf(() => "value");

export const dynamicConstructor = functionPrototype.constructor;
