class Calculator {
  value = 0;

  add(value: number) {
    this.value += value;
  }

  sub(value: number) {
    this.value -= value;
  }

  mul(value: number) {
    this.value *= value;
  }

  div(value: number) {
    if (value === 0) {
      throw new Error("division by zero");
    }
    this.value /= value;
  }
}
