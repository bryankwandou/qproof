// Unit tests for the low-level helpers in src/lib/scanner/rust.ts:
// stripComments, lineOf and functions. Every rule depends on them for
// indexes and line numbers, so their edge cases are pinned here.
//
// Tests named "KNOWN BUG ..." use it.fails: they assert the correct behaviour
// and currently fail. When the bug is fixed, vitest reports them as failing so
// they can be turned into normal tests.
import { describe, expect, it } from "vitest";
import { functions, lineOf, stripComments } from "../src/lib/scanner/rust";

describe("stripComments", () => {
  it("returns empty output for empty input", () => {
    expect(stripComments("")).toBe("");
  });

  it("leaves comment-free code untouched", () => {
    const src = "fn f(a: u8) -> u8 {\n    a + 1\n}";
    expect(stripComments(src)).toBe(src);
  });

  it("replaces a line comment with spaces of the same length", () => {
    const src = "let a = 1; // secret\nlet b = 2;";
    const out = stripComments(src);
    expect(out).toHaveLength(src.length);
    expect(out).not.toContain("secret");
    expect(out.split("\n")[1]).toBe("let b = 2;");
    expect(out.indexOf("let b")).toBe(src.indexOf("let b"));
  });

  it("strips doc comments (///) like any line comment", () => {
    const out = stripComments("/// create_program_address\nfn f() {}");
    expect(out).not.toContain("create_program_address");
    expect(out).toContain("fn f() {}");
  });

  it("strips a block comment and keeps line count and length", () => {
    const src = "a\n/* one\ntwo\nthree */b\nc";
    const out = stripComments(src);
    expect(out).toHaveLength(src.length);
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
    expect(out).not.toMatch(/one|two|three/);
    expect(out.indexOf("b")).toBe(src.indexOf("b"));
  });

  it("keeps // and /* inside string literals", () => {
    const src = 'let url = "https://x.io/*not a comment*/";';
    expect(stripComments(src)).toBe(src);
  });

  it("handles escaped quotes inside strings", () => {
    const src = 'let s = "a \\" // still string"; // real comment';
    const out = stripComments(src);
    expect(out).toContain('"a \\" // still string"');
    expect(out).not.toContain("real comment");
    expect(out).toHaveLength(src.length);
  });

  it("does not crash on an unterminated string", () => {
    expect(() => stripComments('let s = "never closed // x')).not.toThrow();
  });

  it("does not crash on a trailing backslash inside a string", () => {
    expect(() => stripComments('"abc\\')).not.toThrow();
  });

  it("removes the content of an unterminated block comment", () => {
    const out = stripComments("code /* dangling");
    expect(out).not.toContain("dangling");
    expect(out.startsWith("code ")).toBe(true);
  });

  it.fails("KNOWN BUG rust.ts:41-42 keeps the length stable for an unterminated block comment", () => {
    const src = "a /* b";
    expect(stripComments(src)).toHaveLength(src.length);
  });

  it.fails("KNOWN BUG rust.ts:36-44 handles nested block comments (valid Rust)", () => {
    const out = stripComments("/* a /* b */ c */ d");
    expect(out.trim()).toBe("d");
  });

  it.fails("KNOWN BUG rust.ts:23 treats a '\"' char literal as a char, not a string opener", () => {
    const src = "let q = '\"'; // hidden\nlet r = 1;";
    expect(stripComments(src)).not.toContain("hidden");
  });
});

describe("lineOf", () => {
  const src = "l1\nl2\nl3";
  it.each([
    [0, 1],
    [1, 1],
    [2, 1], // the newline itself is still on line 1
    [3, 2],
    [6, 3],
    [7, 3],
  ])("index %i is on line %i", (index, line) => {
    expect(lineOf(src, index)).toBe(line);
  });

  it("clamps indexes past the end to the last line", () => {
    expect(lineOf(src, 1000)).toBe(3);
  });

  it("returns 1 for negative indexes and empty input", () => {
    expect(lineOf(src, -5)).toBe(1);
    expect(lineOf("", 0)).toBe(1);
  });

  it("counts CRLF line endings by their \\n", () => {
    expect(lineOf("a\r\nb\r\nc", 6)).toBe(3);
  });
});

describe("functions", () => {
  it("finds a single function with its name, signature and body", () => {
    const src = "pub fn withdraw(a: u8, b: &[u8]) -> Result<()> {\n  Ok(())\n}";
    const [f] = functions(src);
    expect(f.name).toBe("withdraw");
    expect(f.signature).toContain("withdraw(a: u8, b: &[u8]) -> Result<()>");
    expect(f.body.startsWith("{")).toBe(true);
    expect(f.body.endsWith("}")).toBe(true);
    expect(f.start).toBe(src.indexOf("fn withdraw"));
    expect(f.end).toBe(src.length - 1);
    expect(src[f.sigEnd]).toBe("{");
  });

  it("finds several functions in order", () => {
    const src = "fn a() {}\nfn b(x: u8) { x; }\nfn c() { { nested } }";
    expect(functions(src).map((f) => f.name)).toEqual(["a", "b", "c"]);
  });

  it("matches nested braces to the right closing brace", () => {
    const src = "fn a() { if x { y } else { z } }\nfn b() {}";
    const [a, b] = functions(src);
    expect(a.body).toBe("{ if x { y } else { z } }");
    expect(b.name).toBe("b");
  });

  it("supports simple generics and lifetimes", () => {
    const src = "fn g<'a, T>(x: &'a T) -> &'a T { x }";
    expect(functions(src).map((f) => f.name)).toEqual(["g"]);
  });

  it("supports where clauses between the signature and the body", () => {
    const src = "fn w<T>(x: T) -> u8 where T: Copy { 1 }";
    const [f] = functions(src);
    expect(f.signature).toContain("where T: Copy");
  });

  it("skips trait method declarations without a body", () => {
    const src = "trait T { fn decl(&self) -> u8; }\nfn real() { 1 }";
    expect(functions(src).map((f) => f.name)).toEqual(["real"]);
  });

  it("ignores fn pointer types and identifiers that only contain 'fn'", () => {
    const src = "let cb: fn(u8) -> u8 = id; let define = 1; fn ok() {}";
    expect(functions(src).map((f) => f.name)).toEqual(["ok"]);
  });

  it("returns [] for input with no functions", () => {
    expect(functions("")).toEqual([]);
    expect(functions("struct S { a: u8 }")).toEqual([]);
  });

  it("does not throw on an unbalanced body", () => {
    expect(() => functions("fn broken() { if x {")).not.toThrow();
    expect(functions("fn broken() { if x {")[0]?.name).toBe("broken");
  });

  it.fails("KNOWN BUG rust.ts:85 parses functions with nested generic bounds", () => {
    expect(functions("fn f<T: Into<u8>>(x: T) { }").map((f) => f.name)).toEqual(["f"]);
  });
});
