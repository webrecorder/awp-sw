import { ArchiveDB, ArchiveRequest, ArchiveResponse, CollectionLoader, LiveProxy, SWCollections, randomId } from "@webrecorder/wabac/swlib";
import { postToGetUrl } from "warcio";


// ===========================================================================
export class RecProxy extends ArchiveDB
{
  collLoader: CollectionLoader;
  recordProxied: boolean;
  liveProxy: LiveProxy;
  pageId: string;
  isNew = true;
  firstPageOnly: boolean;
  counter = 0;

  constructor(config: any, collLoader: CollectionLoader) {
    super(config.dbname);

    this.name = config.dbname.slice(3);

    this.collLoader = collLoader;

    this.recordProxied = config.extraConfig.recordProxied || false;

    this.liveProxy = new LiveProxy(config.extraConfig, {cloneResponse: true, allowBody: true});

    this.pageId = randomId();
    this.isNew = true;
    this.firstPageOnly = config.extraConfig.firstPageOnly || false;

    this.counter = 0;
  }

  override _initDB(db: any, ...args : any[]) {
    super._initDB(db, ...args);
    db.createObjectStore("rec");
  }

  async decCounter() {
    this.counter--;
    //console.log("rec counter", this.counter);
    await this.db!.put("rec", this.counter, "numPending");
  }

  async getCounter() : Promise<number | undefined> {
    return await this.db!.get("rec", "numPending");
  }

  override async getResource(request: ArchiveRequest, prefix: string) {
    let req;
    
    if (request.method === "POST" || request.method === "PUT") {
      req = request.request.clone();
    } else {
      req = request.request;
    }

    let response : ArchiveResponse | null = null;

    try {
      this.counter++;
      response = await this.liveProxy.getResource(request, prefix);
    } catch (e) {
      await this.decCounter();
      return null;
    }

    //this.cookie = response.headers.get("x-wabac-preset-cookie");

    // don't record content proxied from specified hosts
    if (!this.recordProxied && this.liveProxy.hostProxy) {
      const parsedUrl = new URL(response!.url);
      if (this.liveProxy.hostProxy[parsedUrl.host]) {
        await this.decCounter();
        return response;
      }
    }

    this.doRecord(response!, req).finally(() => this.decCounter());

    return response;
  }

  async doRecord(response: ArchiveResponse, request: Request) {
    let url = response.url;
    const ts = response.date.getTime();

    const mime = (response.headers.get("content-type") || "").split(";")[0];

    const range = response.headers.get("content-range");

    if (range && !range.startsWith("bytes 0-")) {
      console.log("skip range request: " + range);
      return;
    }

    const status = response.status;
    const statusText = response.statusText;

    const respHeaders = Object.fromEntries(response.headers.entries());
    const reqHeaders = Object.fromEntries(request.headers.entries());

    const payload = new Uint8Array(await response.clonedResponse!.arrayBuffer());

    if (range) {
      const expectedRange = `bytes 0-${payload.length - 1}/${payload.length}`;
      if (range !== expectedRange) {
        console.log("skip range request: " + range);
        return;
      }
    }

    if (request.mode === "navigate") {
      this.pageId = randomId();
      if (!this.firstPageOnly) {
        this.isNew = true;
      }
    }

    const pageId = this.pageId;

    const referrer = request.referrer;

    if (request.method === "POST" || request.method === "PUT") {
      const data = {
        method: request.method,
        postData: await request.text(),
        headers: request.headers,
        url,
      };

      if (postToGetUrl(data)) {
        url = new URL(data.url).href;
      }
    }

    const data = {
      url,
      ts,
      status,
      statusText,
      pageId,
      payload,
      mime,
      respHeaders,
      reqHeaders,
      referrer
    };

    await this.addResource(data);

    await this.collLoader.updateSize(this.name, payload.length, payload.length);

    // don't add page for redirects
    if (this.isNew && (status < 301 || status >= 400) && request.mode === "navigate") {
      //console.log("Page", url, "Referrer", referrer);
      await this.addPages([{id: pageId, url, ts}]);
      this.isNew = false;
    }
  }
}

// ===========================================================================
export class RecordingCollections extends SWCollections
{
  async _initStore(type: string, config: any) {
    let store;

    switch (type) {
    case "recordingproxy":
      store = new RecProxy(config, this);
      if (store.initing) {
        await store.initing;
      }
      return store;
    }

    return await super._initStore(type, config);
  }
}
