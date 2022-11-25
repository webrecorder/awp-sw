## ArchiveWeb.page Service Worker (awp-sw)

This library has been factored out of [ArchiveWeb.page](https://webrecorder/archiveweb.page) and represents the core service worker implementation
necessarily for high-fidelity web archiving.

It extends the [wabac.js](https://webrecorder/wabac.js) library and includes utilities for:
- Downloading a WARC or WACZ from IndexedDB
- Signing of WACZ files
- IPFS support: Uploading of loadable WACZ + replayable page (using ReplayWeb.page) template to IPFS, using [auto-js-ipfs](https://github.com/RangerMauve/auto-js-ipfs)
- IPFS support: Experimental custom chunking of web archives to improve deduplication.
- Extensible JSON API for clients using the service worker.


## Usage

```
yarn install @webrecorder/awp-sw
```

The library is designed to be used as part of ArchiveWeb.page or other tools that use web archives. It is designed to be used and extended
as part of the service worker build.

*TODO: provide examples*
