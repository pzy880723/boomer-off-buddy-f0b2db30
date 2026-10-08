# Fankuang Product List

Product lists display an enrollment badge and an optional filter. The default is unfiltered. Canonical server membership wins; manual false excludes inexpensive products and manual true includes expensive eligible products. Store/status/search/image filters remain combined, applied before paging and counts.

No migration or stock/price/barcode changes. Existing nullable fankuang_override is reused. PC server-side PostgREST filtering was also exercised read-only against the embedded database: 13 eligible records; the combined search returned 2. This read bypassed RLS for syntax verification only; the application retains its existing authenticated client/RLS.

Local verification: 106 backend/PC tests, 9 enrollment regressions, 30 iOS tests and 25 Android tests passed. Android debug APK built; real SwiftUI fixture screenshot inspected. PC cards/rows rendered from actual React components. Native installation and a signed physical iPhone build were not performed in this feature delivery.

Tencent release: listing-retouch-20261009-v2, based on live fankuang-20261008-v2. tencent-source.patch is the scoped live-compatible patch, preserving unrelated runtime fixes. Candidate builds/tests and public login, manifest, catalog, media and worker guards passed. Old release remains for rollback. The release also includes the preceding approved retouch changes.

native-source.tar.gz contains only the native files touched here and the implementation plan. The native checkout has no remote and is largely untracked; this snapshot is recovery material, not a complete standalone repository. No credentials or local user data are included.
