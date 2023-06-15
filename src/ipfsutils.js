import { Downloader } from "./downloader.js";

import { create as createAutoIPFS } from "auto-js-ipfs";

import * as UnixFS from "@ipld/unixfs";
import { CarWriter } from "@ipld/car";
import Queue from "p-queue";

// eslint-disable-next-line no-undef
const autoipfsOpts = {web3StorageToken: __WEB3_STORAGE_TOKEN__};

let autoipfs = null;

export async function setAutoIPFSUrl(url) {
  if (autoipfsOpts.daemonURL !== url) {
    autoipfs = null;
  }
  autoipfsOpts.daemonURL = url;
}

export async function ipfsAdd(coll, downloaderOpts = {}, replayOpts = {}, progress = null) {
  if (!autoipfs) {
    autoipfs = await createAutoIPFS(autoipfsOpts);
  }

  const filename = replayOpts.filename || "webarchive.wacz";

  if (replayOpts.customSplits) {
    const ZIP = new Uint8Array([]);
    const WARC_PAYLOAD = new Uint8Array([]);
    const WARC_GROUP = new Uint8Array([]);
    downloaderOpts.markers = {ZIP, WARC_PAYLOAD, WARC_GROUP};
  }

  const gzip = replayOpts.gzip !== undefined ? replayOpts.gzip : true;

  const dl = new Downloader({...downloaderOpts, coll, filename, gzip});
  const dlResponse = await dl.download(progress);

  if (!coll.config.metadata.ipfsPins) {
    coll.config.metadata.ipfsPins = [];
  }

  let concur;
  let shardSize;
  let capacity;

  if (autoipfs.type === "web3.storage") {
    // for now, web3storage only allows a single-shard uploads, so set this high.
    concur = 1;
    shardSize = 1024 * 1024 * 10000;
    capacity = 1048576 * 200;
  } else {
    concur = 3;
    shardSize = 1024 * 1024 * 5;
    // use default capacity
    // capacity = undefined;
    capacity = 1048576 * 200;
  }

  const { readable, writable } = new TransformStream(
    {},
    UnixFS.withCapacity(capacity)
  );

  const swContent = await fetchBuffer("sw.js", replayOpts.replayBaseUrl || self.location.href);
  const uiContent = await fetchBuffer("ui.js", replayOpts.replayBaseUrl || self.location.href);

  let favicon = null;

  try {
    favicon = await fetchBuffer("https://replayweb.page/build/icon.png");
  } catch (e) {
    console.warn("Couldn't load favicon");
  }

  let url, cid;

  const p = readable
    .pipeThrough(new ShardingStream(shardSize))
    .pipeThrough(new ShardStoringStream(autoipfs, concur))
    .pipeTo(
      new WritableStream({
        write: (res) => {
          if (res.url && res.cid) {
            url = res.url;
            cid = res.cid;
          }
        },
      })
    );

  ipfsGenerateCar( 
    writable, 
    dlResponse.filename, dlResponse.body,
    swContent, uiContent, replayOpts,
    downloaderOpts.markers, favicon,
  );

  await p;

  const res = {cid: cid.toString(), url};

  coll.config.metadata.ipfsPins.push(res);

  console.log("ipfs cid added " + url);

  return res;
}

export async function ipfsRemove(coll) {
  if (!autoipfs) {
    autoipfs = await createAutoIPFS(autoipfsOpts);
  }

  if (coll.config.metadata.ipfsPins) {

    for (const {url} of coll.config.metadata.ipfsPins) {
      try {
        await autoipfs.clear(url);
      } catch (e) {
        console.log("Removal from this IPFS backend not yet implemented");
      }
    }

    coll.config.metadata.ipfsPins = null;
    return true;
  }

  return false;
}

async function fetchBuffer(filename, replayBaseUrl) {
  const resp = await fetch(new URL(filename, replayBaseUrl).href);

  return new Uint8Array(await resp.arrayBuffer());
}

async function ipfsWriteBuff(writer, name, content, dir) {
  const file = UnixFS.createFileWriter(writer);
  if (content instanceof Uint8Array) {
    file.write(content); 
  } else if (content[Symbol.asyncIterator]) {
    for await (const chunk of content) {
      file.write(chunk);
    }
  }
  const link = await file.close(); 
  dir.set(name, link);
}

// ===========================================================================
export async function ipfsGenerateCar(writable, waczPath, 
  waczContent, swContent, uiContent, replayOpts, markers, favicon) {

  const writer = UnixFS.createWriter({ writable });

  const rootDir = UnixFS.createDirectoryWriter(writer);

  const encoder = new TextEncoder();

  const htmlContent = getReplayHtml(waczPath, replayOpts);

  await ipfsWriteBuff(writer, "ui.js", uiContent, rootDir);

  if (replayOpts.showEmbed) {
    const replayDir = UnixFS.createDirectoryWriter(writer);
    await ipfsWriteBuff(writer, "sw.js", swContent, replayDir);
    await rootDir.set("replay", await replayDir.close());
  } else {
    await ipfsWriteBuff(writer, "sw.js", swContent, rootDir);
  }

  if (favicon) {
    await ipfsWriteBuff(writer, "favicon.ico", favicon, rootDir);
  }

  await ipfsWriteBuff(writer, "index.html", encoder.encode(htmlContent), rootDir);

  if (!markers) {
    await ipfsWriteBuff(writer, waczPath, iterate(waczContent), rootDir);
  } else {
    await splitByWarcRecordGroup(writer, waczPath, iterate(waczContent), rootDir, markers);
  }

  const {cid} = await rootDir.close();

  writer.close();

  return cid;
}


async function splitByWarcRecordGroup(writer, waczPath, warcIter, rootDir, markers) {
  let links = [];
  const fileLinks = [];
  let secondaryLinks = [];

  let inZipFile = false;
  let lastChunk = null;
  let currName = null;

  const decoder = new TextDecoder();

  const dirs = {};

  const {ZIP, WARC_PAYLOAD, WARC_GROUP} = markers;

  let file = UnixFS.createFileWriter(writer);

  function getDirAndName(fullpath) {
    const parts = fullpath.split("/");
    const filename = parts.pop();
    return [parts.join("/"), filename];
  }

  const waczDir = UnixFS.createDirectoryWriter(writer);

  let count = 0;

  for await (const chunk of warcIter) {
    if (chunk === ZIP && !inZipFile) {
      if (lastChunk) {
        currName = decoder.decode(lastChunk);
      }
      inZipFile = true;

      if (count) {
        fileLinks.push(await file.close());
        count = 0;
        file = UnixFS.createFileWriter(writer);
      }

    } else if (chunk === ZIP && inZipFile) {

      if (count) {
        links.push(await file.close());
        count = 0;
        file = UnixFS.createFileWriter(writer);
      }

      let link;

      if (secondaryLinks.length) {
        if (links.length) {
          throw new Error("invalid state, secondaryLinks + links?");
        }
        link = await concat(writer, secondaryLinks);
        secondaryLinks = [];
      } else {
        link = await concat(writer, links);
        links = [];
      }

      fileLinks.push(link);

      const [dirName, filename] = getDirAndName(currName);
      currName = null;

      let dir;

      if (!dirName) {
        dir = waczDir;
      } else {
        if (!dirs[dirName]) {
          dirs[dirName] = UnixFS.createDirectoryWriter(writer);
        }
        dir = dirs[dirName];
      }

      dir.set(filename, link);

      inZipFile = false;
    } else if (chunk === WARC_PAYLOAD || chunk === WARC_GROUP) {

      if (!inZipFile) {
        throw new Error("invalid state");
      }

      if (count) {
        links.push(await file.close());
        count = 0;
        file = UnixFS.createFileWriter(writer);

        if (chunk === WARC_GROUP) {
          secondaryLinks.push(await concat(writer, links));
          links = [];
        }
      }
    } else if (chunk.length > 0) {
      if (!inZipFile) {
        lastChunk = chunk;
      }
      file.write(chunk);
      count++;
    }
  }

  fileLinks.push(await file.close());

  for (const [name, dir] of Object.entries(dirs)) {
    waczDir.set(name, await dir.close());
  }

  // for await (const chunk of iterate(waczContent)) {
  //   if (chunk === splitMarker) {
  //     links.push(await file.close());
  //     file = UnixFS.createFileWriter(writer);
  //   } else {
  //     file.write(chunk);
  //   }
  // }

  // const rootDir = UnixFS.createDirectoryWriter(writer);

  // await ipfsWriteBuff(writer, "ui.js", uiContent, rootDir);
  // await ipfsWriteBuff(writer, "sw.js", swContent, rootDir);
  // await ipfsWriteBuff(writer, "index.html", encoder.encode(htmlContent), rootDir);

  rootDir.set("webarchive", await waczDir.close());

  rootDir.set(waczPath, await concat(writer, fileLinks));
}

async function concat(writer, links) {
  //TODO: is this the right way to do this?
  const {fileEncoder, hasher, linker} = writer.settings;
  const advanced = fileEncoder.createAdvancedFile(links);
  const bytes = fileEncoder.encode(advanced);
  const hash = await hasher.digest(bytes);
  const cid = linker.createLink(fileEncoder.code, hash);
  const block = { bytes, cid };
  writer.writer.write(block);

  const link = {
    cid,
    contentByteLength: fileEncoder.cumulativeContentByteLength(links),
    dagByteLength: fileEncoder.cumulativeDagByteLength(bytes, links),
  };

  return link;
}

export const iterate = async function* (stream) {
  const reader = stream.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) {
      return;
    } else {
      yield next.value;
    }
  }
};

export async function encodeBlocks(blocks, root) {
  // @ts-expect-error
  const { writer, out } = CarWriter.create(root);
  /** @type {Error?} */
  let error;
  void (async () => {
    try {
      for await (const block of blocks) {
        // @ts-expect-error
        await writer.put(block);
      }
    } catch (/** @type {any} */ err) {
      error = err;
    } finally {
      await writer.close();
    }
  })();
  const chunks = [];
  for await (const chunk of out) chunks.push(chunk);
  // @ts-expect-error
  if (error != null) throw error;
  const roots = root != null ? [root] : [];
  console.log("chunks", chunks.length);
  return Object.assign(new Blob(chunks), { version: 1, roots });
}

function getReplayHtml(waczPath, replayOpts = {}) {
  const { showEmbed, pageUrl, pageTitle, deepLink, loading } = replayOpts;

  return `
<!doctype html>
  <html class="no-overflow">
  <head>
    <title>${pageTitle || "ReplayWeb.page"}</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <script src="./ui.js"></script>
    <style>
      html, body, replay-web-page, replay-app-main {
        width: 100%;
        height: 100%;
        overflow: hidden;
        margin: 0px;
        padding: 0px;
      }
    </style>
  </head>
  <body>${showEmbed ? `
    <replay-web-page ${deepLink ? "deepLink=\"true\" " : ""} ${pageUrl ? `url="${pageUrl}"` : ""} loading="${loading || ""}" embed="replay-with-info" src="${waczPath}"></replay-web-page>` : `
    <replay-app-main source="${waczPath}"></replay-app-main>`
}
  </body>
</html>`;
}



// Copied from https://github.com/web3-storage/w3protocol/blob/main/packages/upload-client/src/sharding.js

const SHARD_SIZE = 1024 * 1024 * 10;
const CONCURRENT_UPLOADS = 3;

/**
 * Shard a set of blocks into a set of CAR files. The last block is assumed to
 * be the DAG root and becomes the CAR root CID for the last CAR output.
 *
 * @extends {TransformStream<import('@ipld/unixfs').Block, import('./types').CARFile>}
 */
export class ShardingStream extends TransformStream {
  /**
   * @param {import('./types').ShardingOptions} [options]
   */
  constructor(shardSize = SHARD_SIZE) {
    /** @type {import('@ipld/unixfs').Block[]} */
    let shard = [];
    /** @type {import('@ipld/unixfs').Block[] | null} */
    let readyShard = null;
    let size = 0;

    super({
      async transform(block, controller) {
        if (readyShard != null) {
          controller.enqueue(await encodeBlocks(readyShard));
          readyShard = null;
        }
        if (shard.length && size + block.bytes.length > shardSize) {
          readyShard = shard;
          shard = [];
          size = 0;
        }
        shard.push(block);
        size += block.bytes.length;
      },

      async flush(controller) {
        if (readyShard != null) {
          controller.enqueue(await encodeBlocks(readyShard));
        }

        const rootBlock = shard.at(-1);
        if (rootBlock != null) {
          controller.enqueue(await encodeBlocks(shard, rootBlock.cid));
        }
      },
    });
  }
}

/**
 * Upload multiple DAG shards (encoded as CAR files) to the service.
 *
 * Note: an "upload" must be registered in order to link multiple shards
 * together as a complete upload.
 *
 * The writeable side of this transform stream accepts CAR files and the
 * readable side yields `CARMetadata`.
 *
 * @extends {TransformStream<import('./types').CARFile, import('./types').CARMetadata>}
 */
export class ShardStoringStream extends TransformStream {
  constructor(autoipfs, concurrency = CONCURRENT_UPLOADS) {
    const queue = new Queue({ concurrency });
    const abortController = new AbortController();
    super({
      async transform(car, controller) {
        void queue.add(
          async () => {
            try {
              //const opts = { ...options, signal: abortController.signal };
              //const cid = await add(conf, car, opts)
              const resUrls = await autoipfs.uploadCAR(car);

              controller.enqueue({cid: car.roots[0], url: resUrls[0]});

              //const { version, roots, size } = car
              //controller.enqueue({ version, roots, cid, size })
            } catch (err) {
              controller.error(err);
              abortController.abort(err);
            }
          },
          { signal: abortController.signal }
        );

        // retain backpressure by not returning until no items queued to be run
        await queue.onSizeLessThan(1);
      },
      async flush() {
        // wait for queue empty AND pending items complete
        await queue.onIdle();
      },
    });
  }
}
