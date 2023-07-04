import { API } from "@webrecorder/wabac/src/api.js";
import { tsToDate } from "@webrecorder/wabac/src/utils.js";

import { Downloader } from "./downloader.js";
import { Signer } from "./keystore.js";
import { ipfsAdd, ipfsRemove, setAutoIPFSUrl } from "./ipfsutils.js";
import { RecProxy } from "./recproxy.js";

// eslint-disable-next-line no-undef
const DEFAULT_SOFTWARE_STRING = `Webrecorder ArchiveWeb.page ${__AWP_VERSION__}, using warcio.js ${__WARCIO_VERSION__}`;

// ===========================================================================
class ExtAPI extends API
{
  constructor(collections, {softwareString = "", replaceSoftwareString = false} = {}) {
    super(collections);
    this.softwareString = replaceSoftwareString ? softwareString : softwareString + DEFAULT_SOFTWARE_STRING;

    this.uploading = new Map();
  }
  
  get routes() {
    return {
      ...super.routes,
      "downloadPages": "c/:coll/dl",
      "upload": ["c/:coll/upload", "POST"],
      "uploadStatus": "c/:coll/upload",
      "recPending": "c/:coll/recPending",
      "pageTitle": ["c/:coll/pageTitle", "POST"],
      "ipfsAdd": ["c/:coll/ipfs", "POST"],
      "ipfsRemove": ["c/:coll/ipfs", "DELETE"],
      "ipfsDaemonUrl": ["ipfs/daemonUrl", "POST"],
      "publicKey": "publicKey",
    };
  }

  downloaderOpts() {
    const softwareString = this.softwareString;

    const signer = new Signer(softwareString, {cacheSig: true});

    return {softwareString, signer};
  }

  async handleApi(request, params, event) {
    switch (params._route) {
    case "downloadPages":
      return await this.handleDownload(params);

    case "upload":
      return await this.handleUpload(params, request, event);

    case "uploadStatus":
      return await this.getUploadStatus(params);

    case "recPending":
      return await this.recordingPending(params);

    case "pageTitle":
      return await this.updatePageTitle(params.coll, request);

    case "publicKey":
      return await this.getPublicKey();

    case "ipfsAdd":
      return await this.startIpfsAdd(event, request, params.coll);

    case "ipfsRemove":
      return await this.ipfsRemove(request, params.coll);

    case "ipfsDaemonUrl":
      return await this.setIPFSDaemonUrlFromBody(request);

    default:
      return await super.handleApi(request, params);
    }
  }

  async handleDownload(params) {
    const dl = await this.getDownloader(params);
    return dl.download();
  }

  async getDownloader(params) {
    const coll = await this.collections.loadColl(params.coll);
    if (!coll) {
      return {error: "collection_not_found"};
    }

    const pageQ = params._query.get("pages");
    const pageList = pageQ === "all" ? null : pageQ.split(",");

    const format = params._query.get("format") || "wacz";
    let filename = params._query.get("filename");

    return new Downloader({...this.downloaderOpts(), coll, format, filename, pageList});
  }

  async handleUpload(params, request, event) {
    const uploading = this.uploading;

    const prevUpload = uploading.get(params.coll);

    const {url, headers, abortUpload} = await request.json();

    if (prevUpload && prevUpload.status === "uploading") {
      if (abortUpload && prevUpload.abort) {
        prevUpload.abort();
        return {aborted: true};
      }
      return {error: "already_uploading"};
    } else if (abortUpload) {
      return {error: "not_uploading"};
    }

    const dl = await this.getDownloader(params);
    const dlResp = await dl.download();
    const filename = dlResp.filename;

    const abort = new AbortController();
    const signal = abort.signal;

    const counter = new CountingStream(dl.metadata.size, abort);

    const body = dlResp.body.pipeThrough(counter.transformStream());

    try {
      const urlObj = new URL(url);
      urlObj.searchParams.set("name", filename);
      const fetchPromise = fetch(urlObj.href, {method: "PUT", headers, duplex: "half", body, signal});
      uploading.set(params.coll, counter);
      if (event.waitUntil) {
        event.waitUntil(this.uploadFinished(fetchPromise, params.coll, dl.metadata, filename, counter));
      }
      return {uploading: true};
    } catch (e) {
      uploading.delete(params.coll);
      return {error: "upload_failed", details: e.toString()};
    }
  }

  async uploadFinished(fetchPromise, collId, metadata, filename, counter) {
    try {
      const resp = await fetchPromise;
      const json = await resp.json();

      console.log(`Upload finished for ${filename} ${collId}`);

      metadata.lastUploadTime = new Date().getTime();
      metadata.lastUploadId = json.id;
      if (!metadata.mtime) {
        metadata.mtime = metadata.lastUploadTime;
      }
      if (!metadata.ctime) {
        metadata.ctime = metadata.lastUploadTime;
      }
      await this.collections.updateMetadata(collId, metadata);
      counter.status = "done";

    } catch (e) {
      console.log(`Upload failed for ${filename} ${collId}`);
      console.log(e);
      counter.status = counter.aborted ? "aborted" : "failed";
    }
  }

  async getUploadStatus(params) {
    let result = null;
    const counter = this.uploading.get(params.coll);

    if (!counter) {
      result = {status: "idle"};
    } else {
      const { size, totalSize, status } = counter;
      result = {status, size, totalSize};

      if (status !== "uploading") {
        this.uploading.delete(params.coll);
      }
    }

    const coll = await this.collections.loadColl(params.coll);

    if (coll && coll.metadata) {
      result.lastUploadTime = coll.metadata.lastUploadTime;
      result.lastUploadId = coll.metadata.lastUploadId;
      result.ctime = coll.metadata.ctime;
      result.mtime = coll.metadata.mtime;
    }

    return result;
  }

  async recordingPending(params) {
    const coll = await this.collections.loadColl(params.coll);
    if (!coll) {
      return {error: "collection_not_found"};
    }

    if (!(coll.store instanceof RecProxy)) {
      return {error: "invalid_collection"};
    }

    const numPending = await coll.store.getCounter();

    return { numPending };
  }

  async prepareColl(collId, request) {
    const coll = await this.collections.loadColl(collId);
    if (!coll) {
      return {error: "collection_not_found"};
    }

    const body = await this.setIPFSDaemonUrlFromBody(request);

    return {coll, body};
  }

  async setIPFSDaemonUrlFromBody(request) {
    let body;

    try {
      body = await request.json();
      if (body.ipfsDaemonUrl) {
        setAutoIPFSUrl(body.ipfsDaemonUrl);
      }
    } catch (e) {
      body = {};
    }

    return body;
  }

  async startIpfsAdd(event, request, collId) {
    const {coll, body} = await this.prepareColl(collId, request);

    const client = await self.clients.get(event.clientId);

    const p = runIPFSAdd(collId, coll, client, this.downloaderOpts(), this.collections, body);

    if (event.waitUntil) {
      event.waitUntil(p);
    }

    try {
      await p;
    } catch (e) {
      return {error: "ipfs_not_available"};
    }

    return {collId};
  }

  async ipfsRemove(request, collId) {
    const {coll} = await this.prepareColl(collId, request);

    if (await ipfsRemove(coll)) {
      await this.collections.updateMetadata(coll.name, coll.config.metadata);
      return {removed: true};
    }

    return {removed: false};
  }

  async updatePageTitle(collId, request) {
    const json = await request.json();
    let {url, ts, title} = json;

    ts = tsToDate(ts).getTime();

    const coll = await this.collections.loadColl(collId);
    if (!coll) {
      return {error: "collection_not_found"};
    }

    //await coll.store.db.init();

    const result = await coll.store.lookupUrl(url, ts);

    if (!result) {
      return {error: "page_not_found"};
    }

    // drop to second precision for comparison
    const roundedTs = Math.floor(result.ts / 1000) * 1000;
    if (url !== result.url || ts !== roundedTs) {
      return {error: "no_exact_match"};
    }

    const page = await coll.store.db.getFromIndex("pages", "url", url);
    if (!page) {
      return {error: "page_not_found"};
    }
    page.title = title;
    await coll.store.db.put("pages", page);

    return {"added": true};
  }

  async getPublicKey() {
    const { signer } = this.downloaderOpts();
    const keys = await signer.loadKeys();
    if (!keys || !keys.public) {
      return {};
    } else {
      return {publicKey: keys.public};
    }
  }
}

// ===========================================================================
async function runIPFSAdd(collId, coll, client, opts, collections, replayOpts) {
  let size = 0;
  let totalSize = 0;

  const sendMessage = (type, result = null) => {
    if (client) {
      client.postMessage({
        type, collId, size, result, totalSize
      });
    }
  };

  const {url, cid} = await ipfsAdd(coll, opts, replayOpts, (incSize, _totalSize) => {
    size += incSize;
    totalSize = _totalSize;
    sendMessage("ipfsProgress");
  });

  const result = {cid, ipfsURL: url};

  sendMessage("ipfsAdd", result);

  await collections.updateMetadata(coll.name, coll.config.metadata);
}


// ===========================================================================
class CountingStream
{
  constructor(totalSize, abort) {
    this.totalSize = totalSize || 0;
    this.status = "uploading";
    this.size = 0;
    this._abort = abort;
    this.aborted = false;
  }

  abort() {
    if (this._abort) {
      this._abort.abort();
      this.aborted = true;
    }
  }

  transformStream() {
    const counterStream = this;

    return new TransformStream({
      start() {
        counterStream.size = 0;
      },

      transform(chunk, controller) {
        counterStream.size += chunk.length;
        //console.log(`Uploaded: ${counterStream.size}`);
        controller.enqueue(chunk);
      }
    });
  }
}

export { ExtAPI };
