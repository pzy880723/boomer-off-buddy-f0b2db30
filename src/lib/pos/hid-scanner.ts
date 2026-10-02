/** Collect keyboard-wedge scans without consuming ordinary controls or text fields. */
export class PosHidScanner {
  private buffer = "";
  private lastAt = 0;

  reset() {
    this.buffer = "";
    this.lastAt = 0;
  }

  key(key: string, at: number): string | null {
    if (at - this.lastAt > 100) this.buffer = "";
    this.lastAt = at;
    if (key === "Enter") {
      const code = this.buffer.length >= 4 ? this.buffer : null;
      this.reset();
      return code;
    }
    if (key.length === 1 && !/\s/.test(key)) {
      this.buffer = (this.buffer + key).slice(-256);
    } else if (key !== "Shift") {
      this.reset();
    }
    return null;
  }
}
