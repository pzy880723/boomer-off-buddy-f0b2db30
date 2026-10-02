import assert from "node:assert/strict";
import { test } from "node:test";
import { PosHidScanner } from "./hid-scanner";

test("a rapid hardware barcode ends on Enter and resets", () => {
  const scanner = new PosHidScanner();
  [..."2003660812004"].forEach((key, i) => scanner.key(key, i * 12));
  assert.equal(scanner.key("Enter", 170), "2003660812004");
  assert.equal(scanner.key("Enter", 180), null);
});

test("ordinary typing and short keys cannot add a product", () => {
  const scanner = new PosHidScanner();
  [..."hello"].forEach((key, i) => scanner.key(key, i * 200));
  assert.equal(scanner.key("Enter", 1100), null);
  scanner.key("1", 1200);
  assert.equal(scanner.key("Enter", 1210), null);
});

test("dialog, focus and location changes reset partial codes", () => {
  const scanner = new PosHidScanner();
  [..."123456"].forEach((key, i) => scanner.key(key, i * 10));
  scanner.reset();
  assert.equal(scanner.key("Enter", 65), null);
});
