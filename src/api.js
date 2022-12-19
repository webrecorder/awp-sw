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
  }
  
  get routes() {
    return {
      ...super.routes,
      "downloadPages": "c/:coll/dl",
      "recPending": "c/:coll/recPending",
      "pageTitle": ["c/:coll/pageTitle", "POST"],
      "ipfsAdd": ["c/:coll/ipfs", "POST"],
      "ipfsRemove": ["c/:coll/ipfs", "DELETE"],
      "ipfsDaemonUrl": ["ipfsDaemonUrl", "POST"],
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

    default:
      return await super.handleApi(request, params);
    }
  }

  async handleDownload(params) {
    const coll = await this.collections.loadColl(params.coll);
    if (!coll) {
      return {error: "collection_not_found"};
    }

    const pageQ = params._query.get("pages");
    const pageList = pageQ === "all" ? null : pageQ.split(",");

    const format = params._query.get("format") || "wacz";
    let filename = params._query.get("filename");

    const dl = new Downloader({...this.downloaderOpts(), coll, format, filename, pageList});
    return dl.download();
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

    let body;

    try {
      body = await request.json();
      if (body.ipfsDaemonUrl) {
        setAutoIPFSUrl(body.ipfsDaemonUrl);
      }
    } catch (e) {
      body = {};
    }

    return {coll, body};
  }

  async startIpfsAdd(event, request, collId) {
    const {coll, body} = await this.prepareColl(collId, request);

    const client = await self.clients.get(event.clientId);

    const p = runIPFSAdd(collId, coll, client, this.downloaderOpts(), this.collections, body);

    if (event.waitUntil) {
      event.waitUntil(p);
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

  const sendMessage = (type, result = null) => {
    if (client) {
      client.postMessage({
        type, collId, size, result
      });
    }
  };

  const {url, cid} = await ipfsAdd(coll, opts, replayOpts, (incSize) => {
    size += incSize;
    sendMessage("ipfsProgress");
  });

  const result = {cid, ipfsURL: url};

  sendMessage("ipfsAdd", result);

  await collections.updateMetadata(coll.name, coll.config.metadata);
}

export { ExtAPI };
