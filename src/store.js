// JSON 持久化：原子写、写操作串行队列、事务快照回滚、幂等键
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export class JsonStore {
  constructor(file, seedFactory) {
    this.file = file;
    this.seedFactory = seedFactory;
    this.data = null;
    this.chain = Promise.resolve();
    this.idem = new Map(); // key -> {status, body}
  }

  async load() {
    if (!existsSync(this.file)) {
      await mkdir(dirname(this.file), { recursive: true });
      this.data = this.seedFactory();
      await this.#persist();
    } else {
      this.data = JSON.parse(await readFile(this.file, "utf8"));
    }
    return this.data;
  }

  async #persist() {
    const tmp = this.file + ".tmp-" + randomUUID();
    await writeFile(tmp, JSON.stringify(this.data, null, 2));
    await rename(tmp, this.file);
  }

  // 所有写操作经同一队列串行化，避免并发写互相覆盖；同幂等键立即占位，挡住并发重复提交
  mutate(fn, { idemKey = null } = {}) {
    if (idemKey && this.idem.has(idemKey)) {
      // 后来的请求等同一结果，并标记 repeated
      return this.idem.get(idemKey).promise.then((out) => ({ ...out, repeated: true }));
    }
    const job = { promise: null };
    const promise = new Promise((resolve, reject) => {
      this.chain = this.chain.then(async () => {
        const snapshot = JSON.stringify(this.data);
        try {
          let result = fn(this.data);
          if (result && typeof result.then === "function") result = await result;
          await this.#persist();
          resolve({ repeated: false, status: 200, body: result });
        } catch (err) {
          this.data = JSON.parse(snapshot); // 回滚：内存恢复，不落盘
          if (idemKey) this.idem.delete(idemKey);
          reject(err);
        }
      }).catch((err) => {
        if (idemKey) this.idem.delete(idemKey);
        reject(err);
      });
    });
    job.promise = promise;
    if (idemKey) this.idem.set(idemKey, job);
    return promise;
  }

  read(fn) {
    return fn(this.data);
  }
}

export function httpError(status, code, detail) {
  const err = new Error(code || "error");
  err.status = status;
  err.code = code;
  err.detail = detail;
  return err;
}
