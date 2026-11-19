declare module "n8ao" {
  import type { Camera, Scene } from "three";
  import { Pass } from "postprocessing";
  export class N8AOPostPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number);
    configuration: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    setQualityMode(mode: string): void;
  }
}
