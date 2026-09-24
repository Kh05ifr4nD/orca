# Bundled ripgrep notices

Orca ships prebuilt ripgrep (`rg`) binaries from `@vscode/ripgrep-universal` under
`Resources/ripgrep/` and in the standalone runtime's `ripgrep/` directory,
for local, WSL, and SSH-remote search.

- ripgrep: dual-licensed MIT (`LICENSE-MIT`) or Unlicense (`UNLICENSE`).
- PCRE2, statically linked into ripgrep's `--pcre2` support: BSD (`PCRE2-LICENCE.md`).
- musl libc, statically linked into the Linux builds: MIT (`MUSL-COPYRIGHT`).
- jemalloc, ripgrep's allocator on the musl builds: BSD-2-Clause (`JEMALLOC-COPYING`).
- LLVM libunwind, statically linked into the Linux builds by Rust's musl target:
  Apache-2.0 WITH LLVM-exception (`LLVM-LIBUNWIND-LICENSE.TXT`).

- The Rust crates ripgrep itself links: `RUST-CRATE-NOTICES.txt`. Orca elects the Unlicense
  wherever a crate offers it (no notice obligation), and reproduces the MIT text for the four that
  do not. `encoding_rs` additionally carries a non-optional BSD-3-Clause notice for its
  WHATWG-derived encoding data.

The jemalloc and libunwind notices apply to the Linux binaries only; `strings` finds their symbols in
`linux-x64` and `linux-arm64` and in neither the darwin nor win32 builds.
