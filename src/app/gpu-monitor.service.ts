import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export interface GPUStats {
  fps: number;
  renderTime: number;
  memoryUsage?: number;
  gpuActive: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class GPUMonitorService {
  private frames = 0;
  private lastTime = 0;
  private fpsUpdateInterval = 1000; // Update FPS every second
  private animationFrameId: number | null = null;
  private monitoring = false;
  
  public stats = new BehaviorSubject<GPUStats>({
    fps: 0,
    renderTime: 0,
    gpuActive: false
  });
  
  constructor() {}
  
  startMonitoring(): void {
    if (this.monitoring) return;
    
    this.monitoring = true;
    this.frames = 0;
    this.lastTime = performance.now();
    
    // Check if WebGL is available with proper typed context
    const canvas = document.createElement('canvas');
    // Explicitly type the context
    const gl = canvas.getContext('webgl') as WebGLRenderingContext | null || 
              canvas.getContext('experimental-webgl') as WebGLRenderingContext | null;
    
    // If no WebGL, report that GPU is not active
    if (!gl) {
      this.stats.next({
        fps: 0,
        renderTime: 0,
        gpuActive: false
      });
      return;
    }
    
    // Now that gl is properly typed as WebGLRenderingContext, TypeScript knows it has getExtension
    const extensionDebugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    let gpuInfo = 'Unknown GPU';
    
    if (extensionDebugInfo) {
      // UNMASKED_RENDERER_WEBGL constant is on the extension object
      // Type assertion to any is used since the exact type might not be recognized
      gpuInfo = gl.getParameter(extensionDebugInfo.UNMASKED_RENDERER_WEBGL as any);
      console.log('GPU Info:', gpuInfo);
    }
    
    // Start monitoring
    this.updateStats();
  }
  
  stopMonitoring(): void {
    this.monitoring = false;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }
  
  private updateStats(): void {
    if (!this.monitoring) return;
    
    const now = performance.now();
    this.frames++;
    
    // Update FPS counter once per second
    if (now - this.lastTime >= this.fpsUpdateInterval) {
      const fps = Math.round((this.frames * 1000) / (now - this.lastTime));
      const renderTime = (now - this.lastTime) / this.frames;
      
      this.stats.next({
        fps,
        renderTime,
        gpuActive: true
      });
      
      this.frames = 0;
      this.lastTime = now;
    }
    
    this.animationFrameId = requestAnimationFrame(() => this.updateStats());
  }
}