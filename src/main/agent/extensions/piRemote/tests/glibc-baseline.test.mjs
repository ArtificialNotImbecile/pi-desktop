import assert from "node:assert/strict";
import test from "node:test";
import {
  assertGlibcBaseline,
  assertLinuxX64BuildHost,
  referencedGlibcAbiTags,
  referencedGlibcVersions
} from "../scripts/glibc-baseline.mjs";

test("glibc baseline verification accepts only symbol versions at or below the contract", () => {
  const safe = [
    "Name: GLIBC_2.2.5  Flags: none",
    "Name: GLIBC_2.9  Flags: none",
    "Name: GLIBC_2.27  Flags: none",
    "Name: GLIBC_2.3.4  Flags: none"
  ].join("\n");
  assert.deepEqual(referencedGlibcVersions(safe), ["2.2.5", "2.3.4", "2.9", "2.27"]);
  assert.deepEqual(assertGlibcBaseline(safe, "2.27", "tmux.real"), {
    baseline: "2.27",
    required: "2.27",
    versions: ["2.2.5", "2.3.4", "2.9", "2.27"]
  });
});

test("glibc baseline verification rejects a newer build-host dependency", () => {
  assert.throws(
    () => assertGlibcBaseline("GLIBC_2.17 GLIBC_2.28 GLIBC_2.34", "2.27", "tmux.real"),
    /tmux\.real requires GLIBC_2\.34, newer than the declared glibc 2\.27 baseline/u
  );
});

test("glibc baseline verification rejects nonnumeric ABI requirements", () => {
  assert.deepEqual(referencedGlibcAbiTags("Name: GLIBC_ABI_DT_RELR Flags: none"), ["ABI_DT_RELR"]);
  assert.throws(
    () => assertGlibcBaseline("Name: GLIBC_ABI_DT_RELR Flags: none", "2.27", "tmux.real"),
    /tmux\.real requires unsupported GLIBC ABI tag\(s\): GLIBC_ABI_DT_RELR/u
  );
});

test("linux-x64 runtime builds reject non-x64 host-native tools", () => {
  assert.equal(assertLinuxX64BuildHost("x86_64\n", "fixture"), "x86_64");
  assert.throws(
    () => assertLinuxX64BuildHost("aarch64", "Linux build host"),
    /Linux build host architecture aarch64 cannot produce the linux-x64 runtime/u
  );
});
