// An exact rational number, like Python's fractions.Fraction (for the small numbers of
// musical durations, plain integers are exact).

function gcd(a: number, b: number): number {
  a = Math.abs(a)
  b = Math.abs(b)
  while (b) [a, b] = [b, a % b]
  return a
}

export class Fraction {
  readonly numerator: number
  readonly denominator: number

  constructor(numerator: number, denominator = 1) {
    if (denominator === 0) throw new Error('ZeroDivisionError: Fraction(n, 0)')
    if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
      throw new Error(`Fraction needs integers, got ${numerator}/${denominator}`)
    }
    const g = gcd(numerator, denominator) || 1
    const sign = denominator < 0 ? -1 : 1
    this.numerator = (sign * numerator) / g
    this.denominator = (sign * denominator) / g
  }

  static from(value: Fraction | number): Fraction {
    return value instanceof Fraction ? value : new Fraction(value)
  }

  add(other: Fraction | number): Fraction {
    const o = Fraction.from(other)
    return new Fraction(this.numerator * o.denominator + o.numerator * this.denominator, this.denominator * o.denominator)
  }

  sub(other: Fraction | number): Fraction {
    const o = Fraction.from(other)
    return new Fraction(this.numerator * o.denominator - o.numerator * this.denominator, this.denominator * o.denominator)
  }

  mul(other: Fraction | number): Fraction {
    const o = Fraction.from(other)
    return new Fraction(this.numerator * o.numerator, this.denominator * o.denominator)
  }

  div(other: Fraction | number): Fraction {
    const o = Fraction.from(other)
    return new Fraction(this.numerator * o.denominator, this.denominator * o.numerator)
  }

  neg(): Fraction {
    return new Fraction(-this.numerator, this.denominator)
  }

  abs(): Fraction {
    return new Fraction(Math.abs(this.numerator), this.denominator)
  }

  /** <0, 0 or >0 like this - other. */
  compare(other: Fraction | number): number {
    const o = Fraction.from(other)
    return this.numerator * o.denominator - o.numerator * this.denominator
  }

  eq(other: Fraction | number): boolean {
    return this.compare(other) === 0
  }
  lt(other: Fraction | number): boolean {
    return this.compare(other) < 0
  }
  le(other: Fraction | number): boolean {
    return this.compare(other) <= 0
  }
  gt(other: Fraction | number): boolean {
    return this.compare(other) > 0
  }
  ge(other: Fraction | number): boolean {
    return this.compare(other) >= 0
  }

  valueOf(): number {
    return this.numerator / this.denominator
  }

  /** A key for maps and sets, like Python's hash of equal fractions. */
  key(): string {
    return `${this.numerator}/${this.denominator}`
  }

  toString(): string {
    return this.denominator === 1 ? `${this.numerator}` : `${this.numerator}/${this.denominator}`
  }

  static max(...values: Fraction[]): Fraction {
    return values.reduce((a, b) => (b.gt(a) ? b : a))
  }

  static min(...values: Fraction[]): Fraction {
    return values.reduce((a, b) => (b.lt(a) ? b : a))
  }
}
