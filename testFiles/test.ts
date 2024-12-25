// This is a class  named Calculator which has a property "value"    initialized to 0.
//  It also has two methods: "add" and "sub". The "add" method adds a given  value to the current value of  the calculator.
// The "sub" method subtracts a given  value to the current value of  the calculator.
// The methods
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
