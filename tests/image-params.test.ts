import { describe, expect, it } from "vitest";
import {
  buildImageParams,
  isBindingOnlyImageModel,
  isFlux2Model,
  prefersAsyncImage,
  toFlux2MultipartParams,
} from "../src/nonchat-upstream";
import { capabilitiesFor, CATALOG, imageAcceptsReference } from "../src/catalog";

describe("imageAcceptsReference / capabilitiesFor", () => {
  it("marks dual i2i models with image-input", () => {
    expect(imageAcceptsReference("@cf/black-forest-labs/flux-2-dev")).toBe(true);
    expect(imageAcceptsReference("google/nano-banana-pro")).toBe(true);
    expect(imageAcceptsReference("openai/gpt-image-2")).toBe(true);
    expect(imageAcceptsReference("xai/grok-imagine-image")).toBe(true);
  });

  it("does not mark pure t2i models as image-input", () => {
    expect(imageAcceptsReference("@cf/black-forest-labs/flux-1-schnell")).toBe(false);
    expect(imageAcceptsReference("google/imagen-4")).toBe(false);
    expect(imageAcceptsReference("bytedance/seedream-5-pro")).toBe(false);
    expect(imageAcceptsReference("recraft/recraftv4")).toBe(false);
    expect(imageAcceptsReference("@cf/stabilityai/stable-diffusion-xl-base-1.0")).toBe(false);
  });

  it("publishes text-to-image on every image model; image-input only on dual", () => {
    const images = CATALOG.filter((e) => e.modality === "image");
    expect(images.length).toBeGreaterThan(10);
    for (const entry of images) {
      const caps = capabilitiesFor(entry);
      expect(caps).toContain("text-to-image");
      if (imageAcceptsReference(entry.id)) {
        expect(caps).toContain("image-input");
      } else {
        expect(caps).not.toContain("image-input");
      }
    }
  });

  it("marks Hailuo as i2v-required", () => {
    const hailuo = CATALOG.find((e) => e.id.startsWith("minimax/hailuo"));
    expect(hailuo).toBeDefined();
    expect(capabilitiesFor(hailuo!)).toEqual(
      expect.arrayContaining(["image-input", "image-input-required"]),
    );
    expect(capabilitiesFor(hailuo!)).not.toContain("text-to-video");
  });
});

describe("buildImageParams", () => {
  it("maps Google nano-banana ref to image_input[]", () => {
    const p = buildImageParams("google/nano-banana-pro", "edit this", "https://example.com/a.png");
    expect(p).toMatchObject({
      prompt: "edit this",
      output_format: "png",
      image_input: ["https://example.com/a.png"],
    });
  });

  it("maps OpenAI gpt-image ref to images[]", () => {
    const p = buildImageParams("openai/gpt-image-1.5", "style as oil", "data:image/png;base64,abc");
    expect(p).toMatchObject({
      prompt: "style as oil",
      images: ["data:image/png;base64,abc"],
    });
  });

  it("maps xAI Grok image ref to image:{url}", () => {
    const p = buildImageParams("xai/grok-imagine-image", "warmer light", "https://cdn.example/x.png");
    expect(p).toMatchObject({
      prompt: "warmer light",
      response_format: "b64_json",
      image: { url: "https://cdn.example/x.png" },
    });
  });

  it("maps Flux 2 ref to input_image_0 and strips data: prefix", () => {
    const p = buildImageParams(
      "@cf/black-forest-labs/flux-2-dev",
      "same person outdoors",
      "data:image/png;base64,QUJD",
    );
    expect(p.prompt).toBe("same person outdoors");
    expect(p.input_image_0).toBe("QUJD");
    expect(p).not.toHaveProperty("image");
  });

  it("ignores ref on pure t2i Flux-1 schnell", () => {
    const p = buildImageParams(
      "@cf/black-forest-labs/flux-1-schnell",
      "a cat",
      "https://example.com/ignored.png",
    );
    expect(p).toEqual({ prompt: "a cat", width: 512, height: 512, steps: 4 });
  });

  it("uses Imagen-4 schema (aspect_ratio, no output_format)", () => {
    const p = buildImageParams("google/imagen-4", "mountain lake");
    expect(p).toEqual({ prompt: "mountain lake", aspect_ratio: "1:1" });
    expect(p).not.toHaveProperty("output_format");
  });

  it("keeps nano-banana output_format and image_input", () => {
    const p = buildImageParams("google/nano-banana-pro", "edit", "https://example.com/a.png");
    expect(p).toMatchObject({
      prompt: "edit",
      output_format: "png",
      image_input: ["https://example.com/a.png"],
    });
  });
});

describe("flux-2 multipart + binding-only image routing", () => {
  it("flags flux-2 family and stream-out CF models as binding-only", () => {
    expect(isFlux2Model("@cf/black-forest-labs/flux-2-dev")).toBe(true);
    expect(isBindingOnlyImageModel("@cf/black-forest-labs/flux-2-klein-4b")).toBe(true);
    expect(isBindingOnlyImageModel("@cf/leonardo/phoenix-1.0")).toBe(true);
    expect(isBindingOnlyImageModel("@cf/lykon/dreamshaper-8-lcm")).toBe(true);
    expect(isBindingOnlyImageModel("@cf/stabilityai/stable-diffusion-xl-base-1.0")).toBe(true);
    expect(isBindingOnlyImageModel("@cf/black-forest-labs/flux-1-schnell")).toBe(false);
  });

  it("builds multipart envelope with prompt + optional ref image", async () => {
    const mp = toFlux2MultipartParams({
      prompt: "a cat",
      width: 1024,
      height: 1024,
      input_image_0: "QUJD", // "ABC" base64
    });
    expect(mp.multipart.contentType).toMatch(/^multipart\/form-data/);
    expect(mp.multipart.body).toBeTruthy();
    // Drain stream so FormData was well-formed
    const res = new Response(mp.multipart.body, {
      headers: { "content-type": mp.multipart.contentType },
    });
    const form = await res.formData();
    expect(form.get("prompt")).toBe("a cat");
    expect(form.get("width")).toBe("1024");
    expect(form.get("input_image_0")).toBeTruthy();
  });

  it("marks gpt-image-2 as prefers-async", () => {
    expect(prefersAsyncImage("openai/gpt-image-2")).toBe(true);
    expect(prefersAsyncImage("openai/gpt-image-1.5")).toBe(false);
  });
});
