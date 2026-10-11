import { spawn } from "child_process";
import path from "path";
import { config } from "./config";

/**
 * Pluggable background-removal providers. Server-side only: API keys are
 * read ONLY from process.env here and never leave the server.
 */

export interface BgProvider {
  name: "removebg" | "rembg-local" | "none";
  /** Returns a PNG buffer with an alpha channel. */
  removeBackground(input: Buffer): Promise<Buffer>;
}

export const NOT_CONFIGURED_MESSAGE =
  "Background removal not configured — set BG_PROVIDER=removebg (needs REMOVEBG_API_KEY) or BG_PROVIDER=rembg-local (needs Python rembg installed). See AI_API_SETUP.md";

class NoneProvider implements BgProvider {
  name = "none" as const;
  async removeBackground(_input: Buffer): Promise<Buffer> {
    throw new Error(NOT_CONFIGURED_MESSAGE);
  }
}

class RemovebgProvider implements BgProvider {
  name = "removebg" as const;
  private readonly endpoint = "https://api.remove.bg/v1.0/removebg";
  private readonly maxRetries = 2; // 2 retries on 5xx/network (3 attempts total)

  async removeBackground(input: Buffer): Promise<Buffer> {
    const apiKey = config.removebgApiKey;
    if (!apiKey) {
      throw new Error(
        "BG_PROVIDER=removebg but REMOVEBG_API_KEY is not set. Add REMOVEBG_API_KEY to your .env."
      );
    }

    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const form = new FormData();
        form.append("image_file", new Blob([new Uint8Array(input)], { type: "image/png" }), "input.png");
        form.append("size", "auto");

        const res = await fetch(this.endpoint, {
          method: "POST",
          headers: { "X-Api-Key": apiKey }, // never logged, never sent to client
          body: form,
        });

        if (res.ok) {
          const bytes = await res.arrayBuffer();
          return Buffer.from(bytes);
        }
        if (res.status >= 500 && attempt < this.maxRetries) {
          lastError = new Error(`remove.bg server error ${res.status}; retrying`);
          await this.sleep(1000 * (attempt + 1));
          continue;
        }
        if (res.status >= 400 && res.status < 500) {
          const text = await res.text().catch(() => "");
          throw new Error(`remove.bg rejected the request (HTTP ${res.status}): ${text.slice(0, 200)}`);
        }
        throw new Error(`remove.bg failed with HTTP ${res.status}`);
      } catch (err) {
        lastError = err;
        // Do not retry 4xx: rethrow immediately.
        if (err instanceof Error && /HTTP 4\d\d/.test(err.message)) throw err;
        if (attempt < this.maxRetries) {
          await this.sleep(1000 * (attempt + 1));
          continue;
        }
      }
    }
    throw new Error(
      `remove.bg failed after ${this.maxRetries + 1} attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

class RembgLocalProvider implements BgProvider {
  name = "rembg-local" as const;

  async removeBackground(input: Buffer): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      // Bundled adapter `rembg_stdin.py` (stable rembg Python API — works across
      // rembg 1.x/2.x, whose CLIs differ): reads an image on stdin, writes a PNG
      // with alpha on stdout. Model via REMBG_MODEL env (default "u2net").
      // __dirname is server/dist (built) or server/src (tsx dev); the helper
      // lives in server/.
      const helper = path.join(__dirname, "..", "rembg_stdin.py");
      const child = spawn("python3", [helper], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        err ? reject(err) : resolve(Buffer.concat(chunks));
      };

      child.stdout.on("data", (d: Buffer) => chunks.push(d));
      child.stderr.on("data", (d: Buffer) => errChunks.push(d));
      child.on("error", (err) =>
        done(
          new Error(
            `Failed to launch rembg (BG_PROVIDER=rembg-local). Is Python 'rembg' installed? Original error: ${err.message}`
          )
        )
      );
      child.on("close", (code) => {
        if (code === 0 && chunks.length > 0) {
          done();
        } else {
          const stderr = Buffer.concat(errChunks).toString("utf8").slice(0, 500);
          done(
            new Error(
              `rembg exited with code ${code}${stderr ? `: ${stderr}` : ""}. Is Python 'rembg' installed and working?`
            )
          );
        }
      });

      child.stdin.on("error", (err) => done(new Error(`rembg stdin error: ${err.message}`)));
      child.stdin.end(input);
    });
  }
}

export function getProvider(): BgProvider {
  const p = config.bgProvider;
  if (p === "removebg") return new RemovebgProvider();
  if (p === "rembg-local") return new RembgLocalProvider();
  return new NoneProvider();
}
