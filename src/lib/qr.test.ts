import { describe, expect, it } from "vitest";
import { cameraProblemOf, cameraSupport, centerSquare, fitWithin, renderQrSvg } from "./qr";

function domError(name: string) {
  const error = new Error(`${name} happened`);
  error.name = name;
  return error;
}

describe("fitWithin", () => {
  it("scales the largest side down to the limit, keeping the aspect ratio", () => {
    expect(fitWithin(4032, 3024, 1024)).toEqual({ width: 1024, height: 768 });
    expect(fitWithin(3024, 4032, 1024)).toEqual({ width: 768, height: 1024 });
  });

  it("never scales up", () => {
    expect(fitWithin(640, 480, 1024)).toEqual({ width: 640, height: 480 });
  });

  it("gives nothing for an empty picture", () => {
    expect(fitWithin(0, 480, 1024)).toEqual({ width: 0, height: 0 });
  });
});

describe("centerSquare", () => {
  it("is the centred square of a landscape or portrait frame", () => {
    expect(centerSquare(1280, 720)).toEqual({ x: 280, y: 0, size: 720 });
    expect(centerSquare(720, 1280)).toEqual({ x: 0, y: 280, size: 720 });
    expect(centerSquare(640, 640)).toEqual({ x: 0, y: 0, size: 640 });
  });
});

describe("camera problems", () => {
  it("can't use the camera on insecure pages or without getUserMedia", () => {
    expect(cameraSupport({ secure: false, getUserMedia: true })).toBe("insecure");
    expect(cameraSupport({ secure: true, getUserMedia: false })).toBe("unsupported");
    expect(cameraSupport({ secure: true, getUserMedia: true })).toBeNull();
  });

  it("explains getUserMedia rejections, old browsers' names included", () => {
    expect(cameraProblemOf(domError("NotAllowedError"))).toBe("denied");
    expect(cameraProblemOf(domError("PermissionDeniedError"))).toBe("denied");
    expect(cameraProblemOf(domError("SecurityError"))).toBe("denied");
    expect(cameraProblemOf(domError("NotFoundError"))).toBe("no-camera");
    expect(cameraProblemOf(domError("OverconstrainedError"))).toBe("no-camera");
    expect(cameraProblemOf(domError("NotReadableError"))).toBe("busy");
    expect(cameraProblemOf(domError("TrackStartError"))).toBe("busy");
    expect(cameraProblemOf(domError("TypeError"))).toBe("error");
    expect(cameraProblemOf("nope")).toBe("error");
    expect(cameraProblemOf(null)).toBe("error");
  });
});

describe("renderQrSvg", () => {
  it("draws the code as SVG, with the quiet zone asked for", async () => {
    const url = "http://192.168.1.5:3000/nearby/#o=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    const tight = await renderQrSvg(url);
    const standard = await renderQrSvg(url, { margin: 4 });

    expect(tight).toMatch(/^<svg[^>]*viewBox="0 0 (\d+) \1"/);
    const size = (svg: string) => Number(/viewBox="0 0 (\d+)/.exec(svg)[1]);
    expect(size(standard) - size(tight)).toBe(6);
  });
});
