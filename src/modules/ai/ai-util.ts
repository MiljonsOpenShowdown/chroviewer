/** Indexed read that fails loudly instead of yielding undefined (noUncheckedIndexedAccess). */
export function item<T>(list: ArrayLike<T>, index: number): T {
  const value = list[index];
  if (value === undefined) throw new RangeError(`index ${String(index)} out of range (length ${String(list.length)})`);
  return value;
}
