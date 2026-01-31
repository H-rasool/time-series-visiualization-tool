import { Component, OnInit, AfterViewInit, OnDestroy, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpEventType, HttpProgressEvent } from '@angular/common/http';
import { NgxEchartsDirective, NgxEchartsModule } from 'ngx-echarts';
import { parse, ParseResult } from 'papaparse';
import { BehaviorSubject, Subject, Subscription, debounceTime, fromEvent, takeUntil } from 'rxjs';
import { throttle } from 'lodash';

// Import the specific ECharts modules
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  TitleComponent,
  ToolboxComponent,
  LegendComponent,
  DataZoomComponent,
} from 'echarts/components';

// The correct way to import renderers
import { CanvasRenderer } from 'echarts/renderers';

// Import WebGL support - this is the correct import
import { SVGRenderer } from 'echarts/renderers'; // For completeness
import { UniversalTransition } from 'echarts/features';
import { LabelLayout } from 'echarts/features';

// Import the GPU monitor service
import { GPUMonitorService, GPUStats } from './gpu-monitor.service';

// Register necessary ECharts components
echarts.use([
  TitleComponent,
  ToolboxComponent,
  TooltipComponent,
  GridComponent,
  LegendComponent,
  DataZoomComponent,
  LineChart,
  CanvasRenderer,  // Canvas renderer
  LabelLayout,     // Features for better layouts
  UniversalTransition // For animations
]);

// Performance settings interface
interface PerformanceSettings {
  useProgressive: boolean;
  progressiveThreshold: number;
  progressiveChunkSize: number;
  largeThreshold: number;
  throttle: number;
  piecewiseLevels: number[];
}

// ECharts initialization options interface with proper renderer type
interface EChartsInitOptions {
  renderer?: 'canvas' | 'svg'; // This needs to be fixed to match ECharts types
  width?: string | number;
  height?: string | number;
  useDirtyRect?: boolean;
  devicePixelRatio?: number;
}


@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    NgxEchartsDirective
  ],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent implements OnInit, AfterViewInit, OnDestroy {
  private http = inject(HttpClient);
  private cdr = inject(ChangeDetectorRef);
  private gpuMonitor = inject(GPUMonitorService);
  private destroy$ = new Subject<void>();
  
  // UI state
  loading = true;
  progress = 0;
  error: string | null = null;
  loadComplete = false;
  timingReport = '';
  
  // Data state
  csvFilePath = 'assets/1UChannelsData.csv';
  private dataCache = new Map<string, Array<[number, number | null]>>();
  private timestampCache = new Map<string, number>();
  totalPoints = 0;
  visiblePoints = 0;
  
  // Chart options
  chartInstance: any = null;
  chartOption: any = {};
  initOpts: EChartsInitOptions = {
    renderer: 'canvas', // Change to 'canvas' since 'webgl' is not a valid option in ECharts type system
    width: 'auto',
    height: 'auto',
    useDirtyRect: true  // Optimize rendering for partial updates
  };
  
  //hardware acceleration
  useHardwareAcceleration = true;

  // tooltip management
  private _tooltipTimeout: any = null;

  // Store timestamps for the two points to keep track of highlight lines
  // private timestamp1: number | null = null;
  // private timestamp2: number | null = null;

  // Delta management
  selectedPoint1: { primaryChannel: string, timestamp: number, primaryValue: number } | null = null;
  selectedPoint2: { primaryChannel: string, timestamp: number, primaryValue: number } | null = null;
  selectionMode: 'first' | 'second' = 'first'; // Tracks which point we're currently selecting
  showDeltaInfo: boolean = false;
  // Update the deltaInfo type
  deltaInfo: { 
    deltaX: number, 
    deltaTimeFormatted: string,
    channelDeltas: Array<{
      channel: string,
      value1: number,
      value2: number,
      deltaY: number
    }>
  } | null = null;

  // Data management
  rawDataChunks: any[][] = [];
  timeRange: [number, number] = [0, 0];
  columns: string[] = [];
  selectedChannels: string[] = [];

  // Performance settings
  performanceSettings: PerformanceSettings = {
    useProgressive: true,
    progressiveThreshold: 5000,
    progressiveChunkSize: 3000,
    largeThreshold: 2000,
    throttle: 100,
    piecewiseLevels: [500, 1000, 5000, 10000]
  };
  
  // Additional user options
  showSymbols = false;
  zoomLevel = 100;
  autoUpdateChart = true;
  dataChanged$ = new BehaviorSubject<boolean>(false);
  
  // GPU Monitoring properties
  gpuStats: GPUStats = {
    fps: 0,
    renderTime: 0,
    gpuActive: false
  };
  showPerformanceStats = false;
  private gpuMonitorSubscription: Subscription | null = null;
  
  // In ngOnInit()
  ngOnInit(): void {
    this.checkRendererCapability();
    this.setupPerformancePreset();
    this.loadCsvData();
    
    this.dataChanged$
      .pipe(
        debounceTime(300),
        takeUntil(this.destroy$)
      )
      .subscribe(() => {
        if (this.autoUpdateChart) {
          this.updateChartData();
        }
      });
  }
  
  ngAfterViewInit(): void {
    // Handle window resize events
    fromEvent(window, 'resize')
      .pipe(
        debounceTime(300),
        takeUntil(this.destroy$)
      )
      .subscribe(() => {
        if (this.chartInstance) {
          this.chartInstance.resize();
          // this.throttledRedraw();
        }
      });
        
    // Start GPU monitoring
    this.gpuMonitor.startMonitoring();
  }
  
  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.clearCaches();
    this.chartInstance = null;
    

    
    // Stop GPU monitoring
    this.gpuMonitor.stopMonitoring();
    if (this.gpuMonitorSubscription) {
      this.gpuMonitorSubscription.unsubscribe();
      this.gpuMonitorSubscription = null;
    }
  }
  
  onChartInit(event: any): void {
    this.chartInstance = event;
    
    // Initialize delta calculation variables
    if (!this.selectedPoint1) this.selectedPoint1 = null;
    if (!this.selectedPoint2) this.selectedPoint2 = null;
    if (!this.selectionMode) this.selectionMode = 'first';

    // Add custom tooltip DOM event handler
    const chartDom = this.chartInstance.getDom();
    
    // Create a tooltip element
    let tooltipDiv = document.createElement('div');
    tooltipDiv.className = 'custom-echarts-tooltip';
    tooltipDiv.style.cssText = `
      position: absolute;
      background: white;
      border: 2px solid #0066cc;
      border-radius: 4px;
      padding: 10px;
      font-size: 13px;
      z-index: 9999;
      box-shadow: 0 3px 8px rgba(0,0,0,0.3);
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.2s;
      min-width: 200px;
      color: #333;
    `;
    document.body.appendChild(tooltipDiv);
    
    // Add click handler
    chartDom.addEventListener('click', (e: MouseEvent) => {
      // Get mouse position relative to chart
      const rect = chartDom.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      console.log('Chart clicked at point:', x, y);
      console.log('Available channels:', this.selectedChannels);
      
      try {
        // Get the grid configuration from the chart
        const grid = this.chartInstance.getOption().grid;
        
        // Find which grid the click is in
        let seriesIndex = -1;
        for (let i = 0; i < grid.length; i++) {
          const g = grid[i];
          
          // Calculate grid top and bottom positions
          const top = typeof g.top === 'string' ? 
            (parseFloat(g.top) / 100) * rect.height : 
            g.top as number;
            
          const height = typeof g.height === 'string' ? 
            (parseFloat(g.height) / 100) * rect.height : 
            g.height as number;
            
          const bottom = top + height;
          
          // Check if click is within this grid
          if (y >= top && y <= bottom) {
            seriesIndex = i;
            break;
          }
        }
        
        console.log('Grid-based seriesIndex:', seriesIndex);
        
        if (seriesIndex >= 0 && seriesIndex < this.selectedChannels.length) {
          const channelName = this.selectedChannels[seriesIndex];
          console.log('Channel name from selected index:', channelName);
          
          // VERY IMPORTANT: Get data specifically for this channel
          const points = this.dataCache.get(channelName) || [];
          
          if (points.length === 0) {
            console.log('No data points for channel:', channelName);
            return;
          }
          
          // Calculate x position as a percentage of chart width
          const xPercent = x / rect.width;
          
          // Calculate the approximate timestamp based on the range
          const timeRange = this.timeRange[1] - this.timeRange[0];
          const approximateTimestamp = this.timeRange[0] + (timeRange * xPercent);
          
          console.log('Selected channel:', channelName);
          console.log('Approximated timestamp:', new Date(approximateTimestamp).toLocaleString());

          // Debug info about points distribution
          console.log('Total points in channel:', points.length);
          console.log('First few indices:', points.slice(0, 3).map(p => p[0]));
          console.log('Last few indices:', points.slice(-3).map(p => p[0]));
          
          // Find the nearest point in time
          let nearestIndex = -1;
          let minDistance = Infinity;
          
          for (let i = 0; i < points.length; i++) {
            const distance = Math.abs(points[i][0] - approximateTimestamp);
            if (distance < minDistance) {
              minDistance = distance;
              nearestIndex = i;
            }
          }
          
          // After finding the nearest point in your click handler...
          if (nearestIndex >= 0) {
            const point = points[nearestIndex];
            const value = point[1] !== null ? point[1] : 0;
            
            // Delta calculation logic
            if (this.selectionMode === 'first') {
              // Store just the timestamp and the primary channel
              this.selectedPoint1 = {
                primaryChannel: channelName,
                timestamp: point[0],
                primaryValue: value
              };
              
              // Switch to second point selection mode
              this.selectionMode = 'second';
              
              // Mark the first point
              this.markSelectedPoint(1, seriesIndex, point[0], value);
              
              // 
              this.updateDeltaModeIndicator(); 

              // Show a message to the user
              this.showMessage('Select second point for delta calculation');
              
            } else if (this.selectionMode === 'second') {
                this.selectedPoint2 = {
                  primaryChannel: channelName,  // Change from channel to primaryChannel
                  timestamp: point[0],
                  primaryValue: value           // Change from value to primaryValue
                };
                
                // Mark the second point
                this.markSelectedPoint(2, seriesIndex, point[0], value);
              
                
                // Change this line to call the new function
                this.calculateMultiChannelDeltas();  // Instead of this.calculateDelta()
                
                // Reset selection mode for next delta calculation
                this.selectionMode = 'first';
              }

            
            // Original tooltip code starts here
            console.log(`Found nearest point for ${channelName}:`, point, 'at index:', nearestIndex);
            
            // Get surrounding points (2 before and 2 after)
            const surroundingPointsForTooltip = [];
            
            // Add points before current point
            for (let i = Math.max(0, nearestIndex - 2); i < nearestIndex; i++) {
              surroundingPointsForTooltip.push({
                index: i,
                timestamp: new Date(points[i][0]).toLocaleString(),
                value: points[i][1]
              });
            }
            
            // Add current point
            surroundingPointsForTooltip.push({
              index: nearestIndex,
              timestamp: new Date(points[nearestIndex][0]).toLocaleString(),
              value: points[nearestIndex][1],
              isCurrent: true
            });
            
            // Add points after current point
            for (let i = nearestIndex + 1; i < Math.min(points.length, nearestIndex + 3); i++) {
              surroundingPointsForTooltip.push({
                index: i,
                timestamp: new Date(points[i][0]).toLocaleString(),
                value: points[i][1]
              });
            }
            
            // Format the tooltip content
            const date = new Date(point[0]);
            const formattedDate = date.toLocaleString();
            const tooltipValue = point[1] !== null ? point[1].toFixed(4) : 'N/A';
            
            // Find the original raw data point
            let originalValue = 'N/A';
            const timestamp = point[0];
            const rawIndex = this.findRawDataIndex(channelName, timestamp);
            
            if (rawIndex.chunk >= 0 && rawIndex.row >= 0) {
              originalValue = this.rawDataChunks[rawIndex.chunk][rawIndex.row][channelName];
            }
            
            // Build surrounding points table
            let surroundingPointsHTML = `<div style="margin-top: 8px; font-size: 11px;">
              <div style="font-weight: bold; margin-bottom: 4px;">Surrounding Points:</div>
              <table style="width: 100%; border-collapse: collapse;">
                <tr style="border-bottom: 1px solid #ddd;">
                  <th style="text-align: right; padding: 2px 4px;">Index</th>
                  <th style="text-align: left; padding: 2px 4px;">Time</th>
                  <th style="text-align: right; padding: 2px 4px;">Value</th>
                </tr>`;
                
            surroundingPointsForTooltip.forEach(p => {
              // Highlight current point
              const style = p.isCurrent ? 
                'background-color: #e6f3ff; font-weight: bold;' : '';
              
              surroundingPointsHTML += `
                <tr style="${style}">
                  <td style="text-align: right; padding: 2px 4px;">${p.index}</td>
                  <td style="text-align: left; padding: 2px 4px; white-space: nowrap;">${p.timestamp.split(', ')[1]}</td>
                  <td style="text-align: right; padding: 2px 4px;">${p.value !== null ? p.value.toFixed(2) : 'N/A'}</td>
                </tr>`;
            });
            
            surroundingPointsHTML += `</table></div>`;
            
            // Add delta selection info if applicable
            let deltaSelectionInfo = '';
            if (this.selectionMode === 'second' && this.selectedPoint1) {
              deltaSelectionInfo = `
                <div style="margin-top: 8px; padding: 5px; background-color: #fff8e1; border-radius: 4px; font-size: 12px;">
                  <span style="font-weight: bold;">Delta Selection:</span> Point 1 selected. Click another point to calculate delta.
                </div>
              `;
            }
            
            tooltipDiv.innerHTML = `
              <div style="font-weight: bold; margin-bottom: 8px; font-size: 14px; color: #0066cc;">${channelName}</div>
              <div style="margin-bottom: 4px;"><strong>Time:</strong> ${formattedDate}</div>
              <div><strong>Value:</strong> ${tooltipValue}</div>
              <div><strong>Original Value:</strong> ${originalValue}</div>
              <div style="font-size: 10px; color: #666; margin-top: 5px;">Point ${nearestIndex} of ${points.length}</div>
              ${deltaSelectionInfo}
              ${surroundingPointsHTML}
            `;
            
            // Position the tooltip
            tooltipDiv.style.left = (e.clientX + 10) + 'px';
            tooltipDiv.style.top = (e.clientY - 25) + 'px';
            tooltipDiv.style.opacity = '1';
            
            // Keep the tooltip visible for longer (5 seconds)
            if (this._tooltipTimeout) {
              clearTimeout(this._tooltipTimeout);
            }
            
            // Highlight the point if possible
            try {
              this.chartInstance.dispatchAction({
                type: 'highlight',
                seriesIndex: seriesIndex,
                dataIndex: nearestIndex
              });
            } catch (highlightErr) {
              console.log('Could not highlight point:', highlightErr);
            }
            
            // Store timeout ID for later clearing
            this._tooltipTimeout = setTimeout(() => {
              tooltipDiv.style.opacity = '0';
              
              try {
                this.chartInstance.dispatchAction({
                  type: 'downplay',
                  seriesIndex: seriesIndex,
                  dataIndex: nearestIndex
                });
              } catch (downplayErr) {
                console.log('Could not downplay point:', downplayErr);
              }
            }, 5000); // Show for 5 seconds
          }
        }
      } catch (err) {
        console.error('Error processing tooltip:', err);
      }
    });
    
    // Add zooming event handlers
    this.chartInstance.on('datazoom', () => {
      const option = this.chartInstance.getOption();
      const startValue = option.dataZoom[0].startValue;
      const endValue = option.dataZoom[0].endValue;
      this.calculateVisiblePoints(startValue, endValue);
      
      // Use throttled redraw instead of setTimeout
      // this.throttledRedraw();
    });
    
    // Get renderer information 
    const zr = this.chartInstance.getZr();
    const renderer = zr.painter.type || ''; // Use .type instead of .getType()
    console.log('ECharts is using renderer:', renderer);
    
    // Check if hardware acceleration is enabled
    const isHardwareAccelerated = this.isHardwareAccelerated();
    console.log('Hardware acceleration is enabled:', isHardwareAccelerated);
    
    // Check WebGL support
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') as WebGLRenderingContext | null || 
              canvas.getContext('experimental-webgl') as WebGLRenderingContext | null;
    console.log('WebGL supported by browser:', !!gl);
    
    // If we want to use hardware acceleration but it's not currently enabled
    if (this.useHardwareAcceleration && !isHardwareAccelerated && gl) {
      console.log('Attempting to optimize for hardware acceleration');
      
      // Try to force hardware acceleration with Canvas
      const originalOptions = this.chartInstance.getOption();
      const container = this.chartInstance.getDom();
      
      // Store event handlers
      const eventHandlers = this.chartInstance._$eventProcessor ? 
                          this.chartInstance._$eventProcessor._$handlers : {};
      
      try {
        // Save the tooltip element reference
        const savedTooltipDiv = tooltipDiv;
        
        // Dispose of the current instance
        this.chartInstance.dispose();
        
        // Create a new instance with canvas renderer and optimal settings
        this.chartInstance = echarts.init(container, null, {
          renderer: 'canvas', // Use 'canvas' with hardware acceleration 
          devicePixelRatio: window.devicePixelRatio || 1,
          useDirtyRect: false, // Sometimes dirty rect causes issues with hardware acceleration
          width: container.clientWidth,
          height: container.clientHeight
        });
        
        // Set animation off for better performance
        originalOptions.animation = false;
        
        // Re-apply options
        this.chartInstance.setOption(originalOptions);
        
        // Reattach datazoom event handler
        this.chartInstance.on('datazoom', (params: any) => {
          const option = this.chartInstance.getOption();
          const startValue = option.dataZoom[0].startValue;
          const endValue = option.dataZoom[0].endValue;
          this.calculateVisiblePoints(startValue, endValue);
        });
        
        // Re-attach our custom click handler after chart is re-created
        container.addEventListener('click', (e: MouseEvent) => {
          // Get mouse position relative to chart
          const rect = container.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          
          console.log('Chart clicked at point (after reinitialization):', x, y);
          
          try {
            // Calculate which series was clicked based on y position
            const seriesIndex = Math.floor(y / (rect.height / this.selectedChannels.length));
            console.log('Calculated seriesIndex:', seriesIndex);
            
            if (seriesIndex >= 0 && seriesIndex < this.selectedChannels.length) {
              const channelName = this.selectedChannels[seriesIndex];
              const points = this.dataCache.get(channelName) || [];
              
              if (points.length === 0) {
                console.log('No data points for channel:', channelName);
                return;
              }
              
              // Calculate x position as a percentage of chart width
              const xPercent = x / rect.width;
              
              // Calculate the approximate timestamp based on the range
              const timeRange = this.timeRange[1] - this.timeRange[0];
              const approximateTimestamp = this.timeRange[0] + (timeRange * xPercent);
              
              console.log('Approximated timestamp:', new Date(approximateTimestamp).toLocaleString());
              
              // Find the nearest point in time
              let nearestIndex = -1;
              let minDistance = Infinity;
              
              for (let i = 0; i < points.length; i++) {
                const distance = Math.abs(points[i][0] - approximateTimestamp);
                if (distance < minDistance) {
                  minDistance = distance;
                  nearestIndex = i;
                }
              }
              
              if (nearestIndex >= 0) {
                const point = points[nearestIndex];
                console.log('Found nearest point:', point, 'at index:', nearestIndex);
                
                // Format the tooltip content
                const date = new Date(point[0]);
                const formattedDate = date.toLocaleString();
                const value = point[1] !== null ? point[1].toFixed(4) : 'N/A';
                
                savedTooltipDiv.innerHTML = `
                  <div style="font-weight: bold; margin-bottom: 5px;">${channelName}</div>
                  <div><strong>Time:</strong> ${formattedDate}</div>
                  <div><strong>Value:</strong> ${value}</div>
                `;
                
                // Position the tooltip
                savedTooltipDiv.style.left = (e.clientX + 10) + 'px';
                savedTooltipDiv.style.top = (e.clientY - 25) + 'px';
                savedTooltipDiv.style.opacity = '1';
                
                // Highlight the point if possible
                try {
                  this.chartInstance.dispatchAction({
                    type: 'highlight',
                    seriesIndex: seriesIndex,
                    dataIndex: nearestIndex
                  });
                } catch (highlightErr) {
                  console.log('Could not highlight point:', highlightErr);
                }
                
                // Hide tooltip after 3 seconds
                setTimeout(() => {
                  savedTooltipDiv.style.opacity = '0';
                  
                  try {
                    this.chartInstance.dispatchAction({
                      type: 'downplay',
                      seriesIndex: seriesIndex,
                      dataIndex: nearestIndex
                    });
                  } catch (downplayErr) {
                    console.log('Could not downplay point:', downplayErr);
                  }
                }, 3000);
              }
            }
          } catch (err) {
            console.error('Error processing tooltip after reinitialization:', err);
          }
        });
        
        // Check if hardware acceleration is now enabled
        console.log('Hardware acceleration after optimization:', this.isHardwareAccelerated());
      } catch (e) {
        console.error('Failed to apply hardware acceleration optimizations:', e);
      }
    }
    
    // Apply optimizations for canvas
    if (renderer === 'canvas' && zr.painter) {
      this.applyCanvasOptimizations(zr.painter);
    }
  }

/**
 * Marks a selected point on the chart
 */
  markSelectedPoint(pointNumber: number, seriesIndex: number, timestamp: number, value: number): void {
    if (!this.chartInstance) return;
    
    try {
      // Make the markers more visible
      const color = pointNumber === 1 ? '#ff3333' : '#3333ff'; // Brighter red and blue
      
      // Get current chart options and check if series exists
      const option = this.chartInstance.getOption();
      if (!option.series || !option.series[seriesIndex]) {
        console.error('Series not found at index:', seriesIndex);
        return;
      }
      
      // Create markPoint data
      const markPointData = [{
        name: `Point ${pointNumber}`,
        coord: [timestamp, value],
        itemStyle: {
          color: color
        },
        symbolSize: 15,
        symbol: 'pin',
        label: {
          show: true,
          formatter: `P${pointNumber}`,
          position: 'top',
          fontSize: 14,
          color: color,
          fontWeight: 'bold'
        }
      }];
      
      // Update only the specific series for the point marker
      const updateObj: any = {
        series: {}
      };
      
      // Update only the specific series - use index as key
      updateObj.series[seriesIndex] = {
        markPoint: {
          symbol: 'pin',
          symbolSize: 15,
          data: markPointData
        }
      };
      
      this.chartInstance.setOption(updateObj);
      
      
      console.log(`Marked point ${pointNumber} at series ${seriesIndex}, timestamp ${new Date(timestamp).toLocaleString()}, value ${value}`);
    } catch (e) {
      console.error('Error marking selected point:', e);
    }
  }


  // Delta for Multi channels
  calculateMultiChannelDeltas(): void {
    if (!this.selectedPoint1 || !this.selectedPoint2 || !this.chartInstance) return;
    
    const timestamp1 = this.selectedPoint1.timestamp;
    const timestamp2 = this.selectedPoint2.timestamp;
    const deltaX = timestamp2 - timestamp1;
    const deltaTimeFormatted = this.formatTimeDelta(deltaX);
    
    // Calculate delta for each visible channel
    const channelDeltas = [];
    
    for (const channelName of this.selectedChannels) {
      // Get the data for this channel
      const data = this.dataCache.get(channelName) || [];
      
      if (data.length === 0) continue;
      
      // Find nearest points for both timestamps
      let value1 = null;
      let value2 = null;
      
      // Find nearest point to timestamp1
      let minDistance1 = Infinity;
      for (let i = 0; i < data.length; i++) {
        const distance = Math.abs(data[i][0] - timestamp1);
        if (distance < minDistance1) {
          minDistance1 = distance;
          value1 = data[i][1];
        }
      }
      
      // Find nearest point to timestamp2
      let minDistance2 = Infinity;
      for (let i = 0; i < data.length; i++) {
        const distance = Math.abs(data[i][0] - timestamp2);
        if (distance < minDistance2) {
          minDistance2 = distance;
          value2 = data[i][1];
        }
      }
      
      // Calculate delta if both values are found
      if (value1 !== null && value2 !== null) {
        const deltaY = value2 - value1;
        channelDeltas.push({
          channel: channelName,
          value1: value1,
          value2: value2,
          deltaY: deltaY
        });
        
        // Draw delta line for this channel
        this.drawChannelDeltaLine(channelName, timestamp1, value1, timestamp2, value2, deltaY);
      }
    }
    
    // Store the multi-channel delta info
    this.deltaInfo = {
      deltaX,
      deltaTimeFormatted,
      channelDeltas: channelDeltas
    };
    
    this.showDeltaInfo = true;
    
    // Update the delta info panel with multi-channel data
    this.showMultiChannelDeltaInfoPanel();
  }


  // draw Channel Delta Line
  drawChannelDeltaLine(channel: string, timestamp1: number, value1: number, 
                    timestamp2: number, value2: number, deltaY: number): void {
    if (!this.chartInstance) return;
    
    const seriesIndex = this.findChannelSeriesIndex(channel);
    if (seriesIndex === -1) return;
    
    // Different colors for different channels
    const colorMap: {[key: string]: string} = {
      'Line_Voltage_2': '#0066cc',
      'Snubber': '#00cc66',
      'HF_Current': '#cc6600',
      // Add colors for other channels
    };
    
    const color = colorMap[channel] || '#ff6600';
    
    // Create markLine data
    const markLineData = [{
      name: `Delta_${channel}`,
      coords: [
        [timestamp1, value1],
        [timestamp2, value2]
      ],
      lineStyle: {
        color: color,
        width: 2,
        type: 'solid'
      },
      label: {
        show: true,
        position: 'middle',
        formatter: `Δ = ${deltaY.toFixed(4)}`,
        fontSize: 14,
        backgroundColor: 'rgba(255, 255, 255, 0.7)',
        padding: [4, 8],
        borderRadius: 4
      }
    }];
    
    // Update chart to show the delta line
    const updateObj: any = {
      series: {}
    };
    
    updateObj.series[seriesIndex] = {
      markLine: {
        silent: false,
        symbol: ['circle', 'arrow'],
        lineStyle: {
          type: 'dashed',
          width: 2,
          color: color
        },
        data: markLineData
      }
    };
    
    this.chartInstance.setOption(updateObj);
  }

  /**
   * Formats time delta in human-readable format
   */
  formatTimeDelta(milliseconds: number): string {
    const absMilliseconds = Math.abs(milliseconds);
    const seconds = Math.floor(absMilliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) {
      return `${days}d ${hours % 24}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else if (seconds > 0) {
      return `${seconds}s ${absMilliseconds % 1000}ms`;
    } else {
      // Show milliseconds for very small differences
      return `${absMilliseconds}ms`;
    }
  }

  /**
 * Helper to find the series index for a channel
 */
  findChannelSeriesIndex(channelName: string): number {
    if (!this.chartInstance) return -1;
    
    const option = this.chartInstance.getOption();
    if (!option.series || !Array.isArray(option.series)) return -1;
    
    for (let i = 0; i < option.series.length; i++) {
      if (option.series[i].name === channelName) {
        return i;
      }
    }
    
    return -1;
  }

  /**
   * Shows a temporary message to the user
   */
  showMessage(message: string): void {
    console.log(message);
    
    // Create a toast notification that's visible to the user
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      background-color: rgba(0, 0, 0, 0.8);
      color: white;
      padding: 10px 20px;
      border-radius: 4px;
      z-index: 10000;
      font-size: 14px;
      font-weight: bold;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    
    // Remove after 3 seconds
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.5s ease';
      setTimeout(() => toast.remove(), 500);
    }, 3000);
  }

  // Show multi-channel delta info panel
  showMultiChannelDeltaInfoPanel(): void {
    if (!this.deltaInfo) return;
    
    // Remove existing panel if it exists
    const existingPanel = document.getElementById('delta-info-panel');
    if (existingPanel) existingPanel.remove();
    
    // Create a new panel with improved styling
    const deltaInfoEl = document.createElement('div');
    deltaInfoEl.id = 'delta-info-panel';
    deltaInfoEl.style.cssText = `
      position: fixed;
      top: 80px;
      right: 20px;
      background-color: white;
      border: 2px solid #0066cc;
      border-radius: 8px;
      padding: 15px;
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.2);
      z-index: 10000;
      min-width: 280px;
      max-width: 350px;
      font-family: Arial, sans-serif;
    `;
    
    // Create header content
    let content = `
      <div style="font-weight: bold; color: #0066cc; margin-bottom: 10px; border-bottom: 1px solid #e6e6e6; padding-bottom: 8px; font-size: 16px;">
        Delta Calculation Results
      </div>
      <div style="margin-bottom: 8px;">
        <span style="font-weight: 500; color: #555; width: 120px; display: inline-block;">From:</span> 
        <span style="color: #0077cc; font-weight: 500;">${new Date(this.selectedPoint1!.timestamp).toLocaleString()}</span>
      </div>
      <div style="margin-bottom: 8px;">
        <span style="font-weight: 500; color: #555; width: 120px; display: inline-block;">To:</span> 
        <span style="color: #0077cc; font-weight: 500;">${new Date(this.selectedPoint2!.timestamp).toLocaleString()}</span>
      </div>
      <div style="margin-bottom: 15px;">
        <span style="font-weight: 500; color: #555; width: 120px; display: inline-block;">Time Difference:</span> 
        <span style="color: #0077cc; font-weight: 500;">${this.deltaInfo.deltaTimeFormatted}</span>
      </div>
      <div style="margin-bottom: 15px; border-bottom: 1px solid #e6e6e6; padding-bottom: 8px;">
        <span style="font-weight: bold; color: #555;">Channel Delta Values:</span>
      </div>
    `;
    
    // Add each channel's delta values
    if (this.deltaInfo.channelDeltas) {
      this.deltaInfo.channelDeltas.forEach((delta: any) => {
        content += `
          <div style="margin-bottom: 12px;">
            <div style="font-weight: 500; color: #444; margin-bottom: 4px;">${delta.channel}:</div>
            <div style="padding-left: 10px; margin-bottom: 2px;">
              <span style="color: #555; width: 90px; display: inline-block;">From Value:</span> 
              <span style="color: #0077cc;">${delta.value1.toFixed(4)}</span>
            </div>
            <div style="padding-left: 10px; margin-bottom: 2px;">
              <span style="color: #555; width: 90px; display: inline-block;">To Value:</span> 
              <span style="color: #0077cc;">${delta.value2.toFixed(4)}</span>
            </div>
            <div style="padding-left: 10px; font-weight: 500;">
              <span style="color: #555; width: 90px; display: inline-block;">Delta:</span> 
              <span style="color: #0077cc; font-size: 14px;">Δ = ${delta.deltaY.toFixed(4)}</span>
            </div>
          </div>
        `;
      });
    }
    
    // Add clear button
    content += `
      <button id="clearDeltaBtn" style="width: 100%; padding: 8px; background-color: #f0f0f0; border: 1px solid #ccc; border-radius: 4px; cursor: pointer; font-weight: bold; color: #444;">
        Clear Selection
      </button>
    `;
    
    deltaInfoEl.innerHTML = content;
    
    // Add to document
    document.body.appendChild(deltaInfoEl);
    
    // Add event listener to the button
    document.getElementById('clearDeltaBtn')?.addEventListener('click', () => {
      this.clearDeltaSelection();
      deltaInfoEl.remove();
    });
  }

  /**
   * Clears delta selection and resets UI
   */
  clearDeltaSelection(): void {
    this.selectedPoint1 = null;
    this.selectedPoint2 = null;
    this.selectionMode = 'first';
    this.showDeltaInfo = false;
    this.deltaInfo = null;
        
    // Clear markPoints from all series
    if (this.chartInstance) {
      const option = this.chartInstance.getOption();
      const updateObj: any = {
        series: {}
      };
      
      // Clear markPoint from all series
      for (let i = 0; i < this.selectedChannels.length; i++) {
        const channelName = this.selectedChannels[i];
        const seriesIndex = this.findChannelSeriesIndex(channelName);
        
        if (seriesIndex !== -1) {
          updateObj.series[seriesIndex] = {
            markPoint: { data: [] }
          };
        }
      }
      
      this.chartInstance.setOption(updateObj);
    }
    
    // Remove delta info panel and indicators
    const deltaInfoEl = document.getElementById('delta-info-panel');
    if (deltaInfoEl) {
      deltaInfoEl.remove();
    }
    
    const deltaIndicator = document.getElementById('delta-mode-indicator');
    if (deltaIndicator) {
      deltaIndicator.remove();
    }
  }

// Add this new method to update the delta mode indicator
  updateDeltaModeIndicator(): void {
    // Remove existing indicator if present
    const existingIndicator = document.getElementById('delta-mode-indicator');
    if (existingIndicator) existingIndicator.remove();
    
    // If we're in second point selection mode, show the indicator
    if (this.selectionMode === 'second' && this.selectedPoint1) {
      const indicator = document.createElement('div');
      indicator.id = 'delta-mode-indicator';
      indicator.style.cssText = `
        position: fixed;
        top: 10px;
        left: 50%;
        transform: translateX(-50%);
        background-color: #fff8e1;
        border: 1px solid #ffecb3;
        border-radius: 4px;
        padding: 8px 16px;
        z-index: 1000;
        font-size: 14px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      `;
      indicator.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="color: #ff0000; font-weight: bold;">•</span>
          <span>Point 1 selected. Click on second point to calculate delta.</span>
        </div>
      `;
      document.body.appendChild(indicator);
    }
  }


// Add this new method to separate the optimizations
  applyCanvasOptimizations(painter: any): void {
    console.log('Applying performance optimizations for Canvas renderer');
    
    // Set chart animation to false for better performance
    if (this.chartInstance) {
      const opts = this.chartInstance.getOption();
      if (opts) {
        const optimizedOptions = {
          animation: false,
          animationThreshold: 1, // Lower threshold for animations
          progressive: this.performanceSettings.progressiveThreshold,
          progressiveThreshold: this.performanceSettings.progressiveThreshold,
          hoverLayerThreshold: Infinity // Disable hover layer for large datasets
        };
        
        this.chartInstance.setOption(optimizedOptions, false); // Don't merge
      }
    }
    
    // Enable canvas optimizations if we have access to the context
    try {
      // For Canvas renderer we can optimize these settings
      if (painter.ctx) {
        // Set image smoothing to false for better performance
        const ctx = painter.ctx;
        ctx.imageSmoothingEnabled = false;
        ctx.mozImageSmoothingEnabled = false;
        ctx.webkitImageSmoothingEnabled = false;
        ctx.msImageSmoothingEnabled = false;
        
        console.log('Canvas optimizations applied');
      }
    } catch (e) {
      console.warn('Failed to optimize canvas rendering:', e);
    }
  }

  // Debug method to verify channel data matches
  verifyChannelData(): void {
    console.log('Selected channels:', this.selectedChannels);
    
    for (const channel of this.selectedChannels) {
      const data = this.dataCache.get(channel);
      if (data && data.length > 0) {
        console.log(`${channel} data sample:`, data[0], data[Math.floor(data.length/2)], data[data.length-1]);
      } else {
        console.log(`${channel} has no data or is not in cache`);
      }
    }
    
    console.log('Series mapping in chart:');
    const series = this.chartInstance.getOption().series;
    for (let i = 0; i < series.length; i++) {
      console.log(`Series ${i}: ${series[i].name}`);
    }
  }

  // Add this helper method to check for hardware acceleration
  isHardwareAccelerated(): boolean {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    if (!ctx) return false;
    
    // Check for specific properties that indicate hardware acceleration
    try {
      // @ts-ignore: Property may not exist
      return !!(ctx.getContextAttributes && ctx.getContextAttributes().alpha);
    } catch (e) {
      // Fallback detection method
      try {
        const gl = document.createElement('canvas').getContext('webgl');
        if (!gl) return false;
        
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        if (!debugInfo) return false;
        
        const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
        return !renderer.includes('SwiftShader') && 
              !renderer.includes('llvmpipe') && 
              !renderer.includes('software');
      } catch (e) {
        return false;
      }
    }
  }
  
  setupPerformancePreset(): void {
    // Always use speed-optimized settings
    this.performanceSettings = {
      useProgressive: true,
      progressiveThreshold: 5000,
      progressiveChunkSize: 2000,
      largeThreshold: 2000,
      throttle: 30,
      piecewiseLevels: [100, 500, 1000, 5000]
    };
    
    // Apply WebGL specific optimizations
    if (this.chartInstance) {
      const zr = this.chartInstance.getZr();
      // Check if it's canvas renderer, we can still optimize
      if (zr.painter) {
        try {
          zr.painter.configLayer && zr.painter.configLayer(0, {
            clearDepth: 1,
            clearColor: [0, 0, 0, 0],
            renderToTexture: true,
            blendFunc: [770, 771] // SRC_ALPHA, ONE_MINUS_SRC_ALPHA
          });
        } catch (e) {
          console.log('Unable to configure layer:', e);
        }
      }
    }
    
    // Set renderer options for high performance
    this.initOpts = {
      renderer: 'canvas',
      width: 'auto',
      height: 'auto',
      useDirtyRect: true,
      devicePixelRatio: window.devicePixelRatio || 1
    };
    
    // If chart is already initialized, we need to update
    if (this.chartInstance && this.chartInstance.getZr()) {
      // Apply performance options to the existing chart
      const opts = this.chartInstance.getOption();
      if (opts) {
        const optimizedOptions = {
          animation: false,
          animationThreshold: 1,
          progressive: this.performanceSettings.progressiveThreshold,
          progressiveThreshold: this.performanceSettings.progressiveThreshold,
          hoverLayerThreshold: Infinity
        };
        
        this.chartInstance.setOption(optimizedOptions, false);
      }
    }
  }

  
  loadCsvData(): void {
    this.loading = true;
    this.error = null;
    this.progress = 0;
    this.clearCaches();
    this.rawDataChunks = [];
    
    const startTime = performance.now();
    
    // Use HTTP request with progress events
    this.http.get(this.csvFilePath, {
      responseType: 'text',
      reportProgress: true,
      observe: 'events'
    }).subscribe({
      next: (event) => {
        if (event.type === HttpEventType.DownloadProgress) {
          const progressEvent = event as HttpProgressEvent;
          if (progressEvent.total) {
            this.progress = Math.round((progressEvent.loaded / progressEvent.total) * 50);
            this.cdr.detectChanges();
          }
        } else if (event.type === HttpEventType.Response) {
          const csvText = event.body as string;
          this.processCSV(csvText, startTime);
        }
      },
      error: (err) => {
        console.error('CSV load error:', err);
        this.error = `Load error: ${err.message || 'Could not load CSV file'}`;
        this.loading = false;
        this.cdr.detectChanges();
      }
    });
  }

  processCSV(csvText: string, startTime: number): void {
    if (!csvText || csvText.trim() === '') {
      this.error = 'CSV file is empty';
      this.loading = false;
      this.cdr.detectChanges();
      return;
    }
    
    // Extract headers
    const firstRow = csvText.split('\n')[0];
    if (!firstRow) {
      this.error = 'CSV file has no headers';
      this.loading = false;
      this.cdr.detectChanges();
      return;
    }
    
    // Parse headers and set up columns
    const hdrs = firstRow.split(',').map(h => h.trim());
    this.columns = hdrs.slice(1); // Assuming first column is TimeStamp
    
    // Auto-select first two channels if none are selected
    if (!this.selectedChannels.length && this.columns.length) {
      this.selectedChannels = this.columns.slice(0, Math.min(2, this.columns.length));
    }
    
    const total = csvText.split('\n').length;
    this.totalPoints = (total - 1) * this.columns.length; // -1 for header row
    
    let chunkSize = 5000; // Process in chunks to avoid blocking UI
    let chunkStart = 0;
    let currentChunk: any[] = [];
    let minTimestamp = Infinity;
    let maxTimestamp = -Infinity;
    
    console.log(`Processing ${total} rows of CSV data...`);
    
    // Function to process chunks with setTimeout to avoid blocking UI
    const processChunk = () => {
      const chunkEnd = Math.min(chunkStart + chunkSize, total);
      currentChunk = [];
      
      // Parse the current chunk
      parse(csvText.slice(
        csvText.indexOf('\n', chunkStart) + 1,
        chunkEnd < total ? csvText.indexOf('\n', chunkEnd) : undefined
      ), {
        header: false,
        skipEmptyLines: true,
        dynamicTyping: true,
        complete: (results: ParseResult<any>) => {
          for (const row of results.data) {
            if (row && row.length > 1) {
              const processedRow: any = { TimeStamp: row[0] };
              
              // Convert TimeStamp once and cache it
              const ts = this.parseTimestamp(row[0]);
              if (!isNaN(ts)) {
                processedRow._parsedTimestamp = ts;
                
                // Update time range
                minTimestamp = Math.min(minTimestamp, ts);
                maxTimestamp = Math.max(maxTimestamp, ts);
              }
              
              // Process each column
              for (let i = 0; i < this.columns.length; i++) {
                processedRow[this.columns[i]] = row[i + 1];
              }
              
              currentChunk.push(processedRow);
            }
          }
          
          // Add the chunk to our chunks array
          if (currentChunk.length > 0) {
            this.rawDataChunks.push(currentChunk);
          }
          
          // Update progress
          this.progress = 50 + Math.round((chunkEnd / total) * 50);
          this.cdr.detectChanges();
          
          // Continue with next chunk or finish
          chunkStart = chunkEnd;
          if (chunkStart < total) {
            setTimeout(processChunk, 0);
          } else {
            this.timeRange = [minTimestamp, maxTimestamp];
            this.loading = false;
            this.loadComplete = true;
            
            const endTime = performance.now();
            this.timingReport = `CSV loaded in ${((endTime - startTime) / 1000).toFixed(2)}s`;
            console.log(`CSV processing complete. ${this.rawDataChunks.reduce((sum, chunk) => sum + chunk.length, 0)} rows in ${this.rawDataChunks.length} chunks.`);
            
            // Update chart after data is loaded
            this.dataChanged$.next(true);
          }
        },
        error: (err: any) => {
          console.error('CSV parse error while processing chunk:', err);
          this.error = `Parse error: ${err.message}`;
          this.loading = false;
          this.cdr.detectChanges();
        }
      });
    };
    
    // Start processing chunks
    processChunk();
  }
  
  parseTimestamp(ts: string | number): number {
    if (ts === null || ts === undefined) return NaN;
    
    // Check cache first
    if (typeof ts === 'string' && this.timestampCache.has(ts)) {
      return this.timestampCache.get(ts)!;
    }
    
    try {
      // Already a number
      if (typeof ts === 'number') return ts;
      
      let timestamp: number;
      
      // Handle your specific format: DD-MM-YYYY HH:MM:SS:MMM.SSSSSS
      if (ts.includes('-') && ts.includes(':')) {
        const [datePart, timePart] = ts.split(' ');
        
        // Parse date as DD-MM-YYYY
        const [day, month, year] = datePart.split('-').map(Number);
        
        // Handle the complex time format
        const timeSegments = timePart.split(':');
        const hours = parseInt(timeSegments[0], 10);
        const minutes = parseInt(timeSegments[1], 10);
        const seconds = parseInt(timeSegments[2], 10);
        
        // Handle milliseconds.microseconds
        let milliseconds = 0;
        if (timeSegments.length > 3 && timeSegments[3].includes('.')) {
          const [millis, micros] = timeSegments[3].split('.');
          milliseconds = parseInt(millis, 10);
        } else if (timeSegments.length > 3) {
          milliseconds = parseInt(timeSegments[3], 10);
        }
        
        timestamp = new Date(year, month - 1, day, hours, minutes, seconds, milliseconds).getTime();
      } else if (ts.includes('T') || ts.includes('Z')) {
        // ISO format
        timestamp = new Date(ts).getTime();
      } else {
        // Try as a regular date string
        timestamp = new Date(ts).getTime();
      }
      
      // Store in cache
      if (!isNaN(timestamp) && typeof ts === 'string') {
        this.timestampCache.set(ts, timestamp);
      }
      
      return timestamp;
    } catch (e) {
      console.warn('Error parsing timestamp:', ts, e);
      return NaN;
    }
  }

  // Helper method to find original data in raw chunks
  findRawDataIndex(channelName: string, timestamp: number): { chunk: number, row: number } {
    // Look for a close match in raw data chunks
    for (let chunkIndex = 0; chunkIndex < this.rawDataChunks.length; chunkIndex++) {
      const chunk = this.rawDataChunks[chunkIndex];
      
      for (let rowIndex = 0; rowIndex < chunk.length; rowIndex++) {
        const row = chunk[rowIndex];
        
        // Compare parsed timestamps
        if (Math.abs(row._parsedTimestamp - timestamp) < 1) { // Within 1ms
          console.log('Found matching raw data:', row);
          return { chunk: chunkIndex, row: rowIndex };
        }
      }
    }
    
    return { chunk: -1, row: -1 };
  }
    
  isChannelSelected(ch: string): boolean {
    return this.selectedChannels.includes(ch);
  }
  
  toggleChannel(ch: string): void {
    const idx = this.selectedChannels.indexOf(ch);
    if (idx === -1) {
      this.selectedChannels.push(ch);
    } else {
      this.selectedChannels.splice(idx, 1);
    }
    
    // Remove from cache any datasets for channels no longer selected
    if (idx !== -1) {
      this.dataCache.delete(ch);
    }
    
    this.dataChanged$.next(true);
  }
  
  calculateVisiblePoints(startTime: number, endTime: number): void {
    if (!startTime || !endTime) {
      this.visiblePoints = this.totalPoints;
      return;
    }
    
    // Calculate percentage of data visible
    const totalTimeRange = this.timeRange[1] - this.timeRange[0];
    const visibleTimeRange = endTime - startTime;
    const visibleRatio = visibleTimeRange / totalTimeRange;
    
    // Approximate visible points
    const channelCount = this.selectedChannels.length;
    const totalPointsPerChannel = this.rawDataChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    this.visiblePoints = Math.round(totalPointsPerChannel * visibleRatio * channelCount);
  }
  
  updateChartData(): void {
    if (!this.loadComplete || !this.selectedChannels.length || this.rawDataChunks.length === 0) return;
    
    console.time('chartUpdate');
    
    // Performance optimization: prepare channel data only once and cache it
    this.prepareChannelDatasets();
    
    // Always use stacked chart
    this.createStackedChart();
    
    console.timeEnd('chartUpdate');
    
    // Force update of chart if instance exists
    if (this.chartInstance) {
      this.chartInstance.setOption(this.chartOption, {
        notMerge: true,
        lazyUpdate: true
      });
      
      // Debug series mapping
      this.verifyChannelData();

      // Use throttled redraw
      // this.throttledRedraw();
    }
  }
  
  checkRendererCapability(): void {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl') as WebGLRenderingContext | null || 
            canvas.getContext('experimental-webgl') as WebGLRenderingContext | null;
            
  if (!gl) {
    console.warn('WebGL not supported by this browser - falling back to standard Canvas renderer');
    // Fall back to canvas renderer (this is already the default)
    this.initOpts.renderer = 'canvas';
    return;
  }
  
  // Check for any WebGL limitations that might cause problems
  const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  console.log('WebGL max texture size:', maxTextureSize);
  
  if (maxTextureSize < 4096) {
    console.warn('WebGL texture size limited - might affect performance for large datasets');
  }
  
  // Try to detect if running in a virtual environment
  try {
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (debugInfo) {
      const vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
      const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
      console.log('GPU Vendor:', vendor);
      console.log('GPU Renderer:', renderer);
      
      // Detect virtual environments or software renderers
      const isVirtualGPU = renderer.toLowerCase().includes('llvmpipe') || 
                          renderer.toLowerCase().includes('swiftshader') ||
                          renderer.toLowerCase().includes('virtualbox') ||
                          renderer.toLowerCase().includes('vmware');
                          
      if (isVirtualGPU) {
        console.warn('Virtual GPU detected, performance may be limited');
      }
    }
  } catch (e) {
    console.warn('Unable to get detailed GPU info');
  }
  
  // Keep canvas as the renderer, but we'll enable hardware acceleration optimizations
  this.initOpts.renderer = 'canvas'; // Change from 'webgl' to 'canvas'
  
  // Set flag to indicate we should use hardware acceleration optimizations
  this.useHardwareAcceleration = true;
  console.log('Hardware acceleration will be used with Canvas renderer');
}


  prepareChannelDatasets(): void {
    // Only prepare datasets for channels that aren't already cached
    const channelsToProcess = this.selectedChannels.filter(ch => !this.dataCache.has(ch));
    
    if (channelsToProcess.length === 0) return;
    
    console.time('dataPreparation');
    
    // Process each channel that needs processing
    for (const channel of channelsToProcess) {
      const data: Array<[number, number | null]> = [];
      
      // Process all chunks for this channel
      for (const chunk of this.rawDataChunks) {
        for (const row of chunk) {
          const timestamp = row._parsedTimestamp || this.parseTimestamp(row.TimeStamp);
          if (!isNaN(timestamp)) {
            const value = row[channel];
            data.push([timestamp, value !== null && value !== undefined ? value : null]);
          }
        }
      }
      
      // Sort by timestamp (important for line charts)
      data.sort((a, b) => a[0] - b[0]);
      
      // Store in cache
      this.dataCache.set(channel, data);
    }
    
    console.timeEnd('dataPreparation');
    console.log(`Prepared data for ${channelsToProcess.length} channels`);
  }
  
  createStackedChart(): void {
    const channelCount = this.selectedChannels.length;
    const gridHeightPercentage = Math.min(85 / channelCount, 25);
    
    // Create grids for each channel with improved spacing
    const grids = this.selectedChannels.map((_, i) => ({
      left: 70,  // Increase left margin for y-axis labels
      right: 70, // Increase right margin 
      top: `${10 + i * gridHeightPercentage}%`,
      height: `${gridHeightPercentage - 2}%`, // Reduce height slightly for better spacing
      containLabel: true,
      z: 50 + i
    }));
    
    // X axes configuration with improved formatting
    const xAxes = this.selectedChannels.map((_, i) => ({
      type: 'time',
      gridIndex: i,
      scale: true,
      axisLabel: {
        show: i === channelCount - 1, // Only show on last grid
        formatter: (value: number) => {
          return new Date(value).toLocaleString('en-US', {
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
          });
        },
        hideOverlap: true,
        fontSize: 11,  // Smaller font size
        margin: 12     // Increase margin
      },
      splitLine: {
        show: true,
        lineStyle: {
          type: 'dashed',
          opacity: 0.2
        }
      },
      min: this.timeRange[0],
      max: this.timeRange[1]
    }));
    
    // Y axes configuration with improved formatting
    const yAxes = this.selectedChannels.map((ch, i) => ({
      type: 'value',
      gridIndex: i,
      name: ch,
      nameLocation: 'middle',
      nameGap: 50,    // Increase gap for better readability
      nameTextStyle: {
        fontSize: 12,
        fontWeight: 'bold',
        align: 'right',
        padding: [0, 0, 0, 10] // Add padding to the name
      },
      scale: true,
      axisLabel: {
        fontSize: 11,
        formatter: (value: number) => {
          // Format large numbers for better readability
          if (Math.abs(value) >= 1000) {
            return (value / 1000).toFixed(1) + 'k';
          }
          return value.toFixed(value % 1 === 0 ? 0 : 1);
        }
      },
      splitLine: {
        show: true,
        lineStyle: {
          type: 'dashed',
          opacity: 0.2
        }
      }
    }));
    
    // Series configuration with improved styling
    const series = this.selectedChannels.map((ch, i) => {
      const data = this.dataCache.get(ch) || [];
      
      return {
        name: ch,
        type: 'line',
        xAxisIndex: i,
        yAxisIndex: i,
        data: data,
        showSymbol: false, // Always hide symbols for better performance
        large: true,
        largeThreshold: 2000, // Set to a reasonable value for performance
        progressive: 5000,   // Fixed value for progressive rendering
        progressiveThreshold: 5000,
        progressiveChunkMode: 'sequential',
        progressiveChunkSize: 2000,
        animation: false,    // Disable animation for better performance
        lineStyle: {
          width: 1.5,        // Slightly thicker lines for better visibility
          color: this.getColorForChannel(i), // Add custom colors per channel
          join: 'bevel'
        },
        itemStyle: {
          borderWidth: 1.5
        }
      };
    });
    
    // Create the chart option with improved configuration
    this.chartOption = {
      title: {
        text: `Time Series Data Visualization (${this.totalPoints.toLocaleString()} points)`,
        left: 'center',
        top: 5,
        textStyle: {
          fontSize: 16,
          fontWeight: 'bold'
        }
      },
      tooltip: {
        show: false, // Turn off ECharts built-in tooltip
        triggerOn: 'none'
      },
      toolbox: {
        feature: {
          dataZoom: { 
            yAxisIndex: 'none',
            xAxisIndex: xAxes.map((_, i) => i),
            icon: {
              zoom: 'path://M0,13.5h26.9 M13.5,26.9V0 M32.1,13.5H58V58H13.5 V32.1',
              back: 'path://M22,1.4L9.9,13.5l12.3,12.3 M10.3,13.5H54.9v44.6 H10.3v-26'
            }
          },
          restore: {},
          saveAsImage: {}
        },
        right: 10,
        top: 10
      },
      dataZoom: [
        {
          type: 'slider',
          xAxisIndex: xAxes.map((_, i) => i),
          start: 0,
          end: 100,
          bottom: 10,
          height: 25,
          borderColor: '#ccc',
          fillerColor: 'rgba(30,144,255,0.15)',
          throttle: 30, // Lower throttle for more responsive zooming
          handleIcon: 'path://M10.7,11.9v-1.3H9.3v1.3c-4.9,0.3-8.8,4.4-8.8,9.4c0,5,3.9,9.1,8.8,9.4v1.3h1.3v-1.3c4.9-0.3,8.8-4.4,8.8-9.4C19.5,16.3,15.6,12.2,10.7,11.9z M13.3,24.4H6.7V23h6.6V24.4z M13.3,19.6H6.7v-1.4h6.6V19.6z',
          handleSize: '80%',
          handleStyle: {
            color: '#fff',
            shadowBlur: 3,
            shadowColor: 'rgba(0, 0, 0, 0.6)',
            shadowOffsetX: 2,
            shadowOffsetY: 2
          }
        },
        {
          type: 'inside',
          xAxisIndex: xAxes.map((_, i) => i),
          throttle: 30, // Lower throttle for more responsive zooming
          zoomOnMouseWheel: true,
          moveOnMouseMove: true
        }
      ],
      grid: grids,
      xAxis: xAxes,
      yAxis: yAxes,
      series: series,
      // Add visual map for better data point coloring
      visualMap: {
        show: false,
        dimension: 1, // Use y-axis value for color mapping
        seriesIndex: series.map((_, i) => i),
        inRange: {
          color: series.map((_, i) => this.getColorForChannel(i))
        }
      }
    };
  }

  // Add this new method to generate custom colors for channels
  getColorForChannel(index: number): string {
    // A set of pleasant colors that work well for time series
    const colors = [
      '#5470c6', '#91cc75', '#fac858', '#ee6666', 
      '#73c0de', '#3ba272', '#fc8452', '#9a60b4',
      '#ea7ccc', '#4ec1cb', '#4d7f3e', '#6b4c9a'
    ];
    
    return colors[index % colors.length];
  }
  
  selectAllChannels(): void {
    this.selectedChannels = [...this.columns];
    this.dataChanged$.next(true);
  }
  
  deselectAllChannels(): void {
    this.selectedChannels = [];
    this.dataChanged$.next(true);
  }
  
  
  exportData(): void {
    if (!this.selectedChannels.length || this.rawDataChunks.length === 0) return;
    
    // 1) Headers
    const headers = ['TimeStamp', ...this.selectedChannels].join(',');
    
    // 2) One output line per data point
    const lines: string[] = [];
    let rowCount = 0;
    
    for (const chunk of this.rawDataChunks) {
      for (const row of chunk) {
        if (rowCount >= 1000000) {
          console.warn('Export limited to 1 million rows to avoid browser crashes');
          break;
        }
        
        // Use the original timestamp string (row.TimeStamp)
        const vals = this.selectedChannels.map(ch => {
          const val = row[ch];
          // Handle numbers, strings, and null/undefined
          if (val === null || val === undefined) return '';
          return val;
        });
        
        lines.push([row.TimeStamp, ...vals].join(','));
        rowCount++;
      }
    }
    
    // 3) Combine and download
    const csv = [headers, ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'time_series_export.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 100);
  }
  
  clearCaches(): void {
    // Free memory by clearing caches
    this.dataCache.clear();
    this.timestampCache.clear();
  }
  

}



// import { Component, OnInit, AfterViewInit, OnDestroy, inject, ChangeDetectorRef } from '@angular/core';
// import { CommonModule } from '@angular/common';
// import { FormsModule } from '@angular/forms';
// import { HttpClient, HttpEventType, HttpProgressEvent } from '@angular/common/http';
// import { NgxEchartsDirective, NgxEchartsModule } from 'ngx-echarts';
// import { parse, ParseResult } from 'papaparse';
// import { BehaviorSubject, Subject, Subscription, debounceTime, fromEvent, takeUntil } from 'rxjs';
// import { throttle } from 'lodash';

// // Import the specific ECharts modules
// import * as echarts from 'echarts/core';
// import { LineChart } from 'echarts/charts';
// import {
//   GridComponent,
//   TooltipComponent,
//   TitleComponent,
//   ToolboxComponent,
//   LegendComponent,
//   DataZoomComponent,
// } from 'echarts/components';

// // The correct way to import renderers
// import { CanvasRenderer } from 'echarts/renderers';

// // Import WebGL support - this is the correct import
// import { SVGRenderer } from 'echarts/renderers'; // For completeness
// import { UniversalTransition } from 'echarts/features';
// import { LabelLayout } from 'echarts/features';

// // Import the GPU monitor service
// import { GPUMonitorService, GPUStats } from './gpu-monitor.service';

// // Register necessary ECharts components
// echarts.use([
//   TitleComponent,
//   ToolboxComponent,
//   TooltipComponent,
//   GridComponent,
//   LegendComponent,
//   DataZoomComponent,
//   LineChart,
//   CanvasRenderer,  // Canvas renderer
//   LabelLayout,     // Features for better layouts
//   UniversalTransition // For animations
// ]);

// // Performance settings interface
// interface PerformanceSettings {
//   useProgressive: boolean;
//   progressiveThreshold: number;
//   progressiveChunkSize: number;
//   largeThreshold: number;
//   throttle: number;
//   piecewiseLevels: number[];
// }

// // ECharts initialization options interface with proper renderer type
// interface EChartsInitOptions {
//   renderer?: 'canvas' | 'svg'; // This needs to be fixed to match ECharts types
//   width?: string | number;
//   height?: string | number;
//   useDirtyRect?: boolean;
//   devicePixelRatio?: number;
// }


// @Component({
//   selector: 'app-root',
//   standalone: true,
//   imports: [
//     CommonModule,
//     FormsModule,
//     NgxEchartsDirective
//   ],
//   templateUrl: './app.component.html',
//   styleUrls: ['./app.component.scss']
// })
// export class AppComponent implements OnInit, AfterViewInit, OnDestroy {
//   private http = inject(HttpClient);
//   private cdr = inject(ChangeDetectorRef);
//   private gpuMonitor = inject(GPUMonitorService);
//   private destroy$ = new Subject<void>();
  
//   // UI state
//   loading = true;
//   progress = 0;
//   error: string | null = null;
//   loadComplete = false;
//   timingReport = '';
  
//   // Data state
//   csvFilePath = 'assets/1UChannelsData.csv';
//   private dataCache = new Map<string, Array<[number, number | null]>>();
//   private timestampCache = new Map<string, number>();
//   totalPoints = 0;
//   visiblePoints = 0;
  
//   // Chart options
//   chartInstance: any = null;
//   chartOption: any = {};
//   initOpts: EChartsInitOptions = {
//     renderer: 'canvas', // Change to 'canvas' since 'webgl' is not a valid option in ECharts type system
//     width: 'auto',
//     height: 'auto',
//     useDirtyRect: true  // Optimize rendering for partial updates
//   };
  
//   //hardware acceleration
//   useHardwareAcceleration = true;

//   // tooltip management
//   private _tooltipTimeout: any = null;

//   // Store timestamps for the two points to keep track of highlight lines
//   // private timestamp1: number | null = null;
//   // private timestamp2: number | null = null;

//   // Delta management
//   selectedPoint1: { primaryChannel: string, timestamp: number, primaryValue: number } | null = null;
//   selectedPoint2: { primaryChannel: string, timestamp: number, primaryValue: number } | null = null;
//   selectionMode: 'first' | 'second' = 'first'; // Tracks which point we're currently selecting
//   showDeltaInfo: boolean = false;
//   // Update the deltaInfo type
//   deltaInfo: { 
//     deltaX: number, 
//     deltaTimeFormatted: string,
//     channelDeltas: Array<{
//       channel: string,
//       value1: number,
//       value2: number,
//       deltaY: number
//     }>
//   } | null = null;

//   // Data management
//   rawDataChunks: any[][] = [];
//   timeRange: [number, number] = [0, 0];
//   columns: string[] = [];
//   selectedChannels: string[] = [];

//   // Performance settings
//   performanceSettings: PerformanceSettings = {
//     useProgressive: true,
//     progressiveThreshold: 5000,
//     progressiveChunkSize: 3000,
//     largeThreshold: 2000,
//     throttle: 100,
//     piecewiseLevels: [500, 1000, 5000, 10000]
//   };
  
//   // Additional user options
//   showSymbols = false;
//   zoomLevel = 100;
//   autoUpdateChart = true;
//   dataChanged$ = new BehaviorSubject<boolean>(false);
  
//   // GPU Monitoring properties
//   gpuStats: GPUStats = {
//     fps: 0,
//     renderTime: 0,
//     gpuActive: false
//   };
//   showPerformanceStats = false;
//   private gpuMonitorSubscription: Subscription | null = null;
  
//   // In ngOnInit()
//   ngOnInit(): void {
//     this.checkRendererCapability();
//     this.setupPerformancePreset();
//     this.loadCsvData();
    
//     this.dataChanged$
//       .pipe(
//         debounceTime(300),
//         takeUntil(this.destroy$)
//       )
//       .subscribe(() => {
//         if (this.autoUpdateChart) {
//           this.updateChartData();
//         }
//       });
//   }
  
//   ngAfterViewInit(): void {
//     // Handle window resize events
//     fromEvent(window, 'resize')
//       .pipe(
//         debounceTime(300),
//         takeUntil(this.destroy$)
//       )
//       .subscribe(() => {
//         if (this.chartInstance) {
//           this.chartInstance.resize();
//           // this.throttledRedraw();
//         }
//       });
        
//     // Start GPU monitoring
//     this.gpuMonitor.startMonitoring();
//   }
  
//   ngOnDestroy(): void {
//     this.destroy$.next();
//     this.destroy$.complete();
//     this.clearCaches();
//     this.chartInstance = null;
    

    
//     // Stop GPU monitoring
//     this.gpuMonitor.stopMonitoring();
//     if (this.gpuMonitorSubscription) {
//       this.gpuMonitorSubscription.unsubscribe();
//       this.gpuMonitorSubscription = null;
//     }
//   }
  
//   onChartInit(event: any): void {
//     this.chartInstance = event;
    
//     // Initialize delta calculation variables
//     if (!this.selectedPoint1) this.selectedPoint1 = null;
//     if (!this.selectedPoint2) this.selectedPoint2 = null;
//     if (!this.selectionMode) this.selectionMode = 'first';

//     // Add custom tooltip DOM event handler
//     const chartDom = this.chartInstance.getDom();
    
//     // Create a tooltip element
//     let tooltipDiv = document.createElement('div');
//     tooltipDiv.className = 'custom-echarts-tooltip';
//     tooltipDiv.style.cssText = `
//       position: absolute;
//       background: white;
//       border: 2px solid #0066cc;
//       border-radius: 4px;
//       padding: 10px;
//       font-size: 13px;
//       z-index: 9999;
//       box-shadow: 0 3px 8px rgba(0,0,0,0.3);
//       pointer-events: none;
//       opacity: 0;
//       transition: opacity 0.2s;
//       min-width: 200px;
//       color: #333;
//     `;
//     document.body.appendChild(tooltipDiv);
    
//     // Add click handler
//     chartDom.addEventListener('click', (e: MouseEvent) => {
//       // Get mouse position relative to chart
//       const rect = chartDom.getBoundingClientRect();
//       const x = e.clientX - rect.left;
//       const y = e.clientY - rect.top;
      
//       console.log('Chart clicked at point:', x, y);
//       console.log('Available channels:', this.selectedChannels);
      
//       try {
//         // Get the grid configuration from the chart
//         const grid = this.chartInstance.getOption().grid;
        
//         // Find which grid the click is in
//         let seriesIndex = -1;
//         for (let i = 0; i < grid.length; i++) {
//           const g = grid[i];
          
//           // Calculate grid top and bottom positions
//           const top = typeof g.top === 'string' ? 
//             (parseFloat(g.top) / 100) * rect.height : 
//             g.top as number;
            
//           const height = typeof g.height === 'string' ? 
//             (parseFloat(g.height) / 100) * rect.height : 
//             g.height as number;
            
//           const bottom = top + height;
          
//           // Check if click is within this grid
//           if (y >= top && y <= bottom) {
//             seriesIndex = i;
//             break;
//           }
//         }
        
//         console.log('Grid-based seriesIndex:', seriesIndex);
        
//         if (seriesIndex >= 0 && seriesIndex < this.selectedChannels.length) {
//           const channelName = this.selectedChannels[seriesIndex];
//           console.log('Channel name from selected index:', channelName);
          
//           // VERY IMPORTANT: Get data specifically for this channel
//           const points = this.dataCache.get(channelName) || [];
          
//           if (points.length === 0) {
//             console.log('No data points for channel:', channelName);
//             return;
//           }
          
//           // Calculate x position as a percentage of chart width
//           const xPercent = x / rect.width;
          
//           // Calculate the approximate timestamp based on the range
//           const timeRange = this.timeRange[1] - this.timeRange[0];
//           const approximateTimestamp = this.timeRange[0] + (timeRange * xPercent);
          
//           console.log('Selected channel:', channelName);
//           console.log('Approximated timestamp:', new Date(approximateTimestamp).toLocaleString());

//           // Debug info about points distribution
//           console.log('Total points in channel:', points.length);
//           console.log('First few indices:', points.slice(0, 3).map(p => p[0]));
//           console.log('Last few indices:', points.slice(-3).map(p => p[0]));
          
//           // Find the nearest point in time
//           let nearestIndex = -1;
//           let minDistance = Infinity;
          
//           for (let i = 0; i < points.length; i++) {
//             const distance = Math.abs(points[i][0] - approximateTimestamp);
//             if (distance < minDistance) {
//               minDistance = distance;
//               nearestIndex = i;
//             }
//           }
          
//           // After finding the nearest point in your click handler...
//           if (nearestIndex >= 0) {
//             const point = points[nearestIndex];
//             const value = point[1] !== null ? point[1] : 0;
            
//             // Delta calculation logic
//             if (this.selectionMode === 'first') {
//               // Store just the timestamp and the primary channel
//               this.selectedPoint1 = {
//                 primaryChannel: channelName,
//                 timestamp: point[0],
//                 primaryValue: value
//               };
              
//               // Switch to second point selection mode
//               this.selectionMode = 'second';
              
//               // Mark the first point
//               this.markSelectedPoint(1, seriesIndex, point[0], value);
              
//               // 
//               this.updateDeltaModeIndicator(); 

//               // Show a message to the user
//               this.showMessage('Select second point for delta calculation');
              
//             } else if (this.selectionMode === 'second') {
//                 this.selectedPoint2 = {
//                   primaryChannel: channelName,  // Change from channel to primaryChannel
//                   timestamp: point[0],
//                   primaryValue: value           // Change from value to primaryValue
//                 };
                
//                 // Mark the second point
//                 this.markSelectedPoint(2, seriesIndex, point[0], value);
              
                
//                 // Change this line to call the new function
//                 this.calculateMultiChannelDeltas();  // Instead of this.calculateDelta()
                
//                 // Reset selection mode for next delta calculation
//                 this.selectionMode = 'first';
//               }

            
//             // Original tooltip code starts here
//             console.log(`Found nearest point for ${channelName}:`, point, 'at index:', nearestIndex);
            
//             // Get surrounding points (2 before and 2 after)
//             const surroundingPointsForTooltip = [];
            
//             // Add points before current point
//             for (let i = Math.max(0, nearestIndex - 2); i < nearestIndex; i++) {
//               surroundingPointsForTooltip.push({
//                 index: i,
//                 timestamp: new Date(points[i][0]).toLocaleString(),
//                 value: points[i][1]
//               });
//             }
            
//             // Add current point
//             surroundingPointsForTooltip.push({
//               index: nearestIndex,
//               timestamp: new Date(points[nearestIndex][0]).toLocaleString(),
//               value: points[nearestIndex][1],
//               isCurrent: true
//             });
            
//             // Add points after current point
//             for (let i = nearestIndex + 1; i < Math.min(points.length, nearestIndex + 3); i++) {
//               surroundingPointsForTooltip.push({
//                 index: i,
//                 timestamp: new Date(points[i][0]).toLocaleString(),
//                 value: points[i][1]
//               });
//             }
            
//             // Format the tooltip content
//             const date = new Date(point[0]);
//             const formattedDate = date.toLocaleString();
//             const tooltipValue = point[1] !== null ? point[1].toFixed(4) : 'N/A';
            
//             // Find the original raw data point
//             let originalValue = 'N/A';
//             const timestamp = point[0];
//             const rawIndex = this.findRawDataIndex(channelName, timestamp);
            
//             if (rawIndex.chunk >= 0 && rawIndex.row >= 0) {
//               originalValue = this.rawDataChunks[rawIndex.chunk][rawIndex.row][channelName];
//             }
            
//             // Build surrounding points table
//             let surroundingPointsHTML = `<div style="margin-top: 8px; font-size: 11px;">
//               <div style="font-weight: bold; margin-bottom: 4px;">Surrounding Points:</div>
//               <table style="width: 100%; border-collapse: collapse;">
//                 <tr style="border-bottom: 1px solid #ddd;">
//                   <th style="text-align: right; padding: 2px 4px;">Index</th>
//                   <th style="text-align: left; padding: 2px 4px;">Time</th>
//                   <th style="text-align: right; padding: 2px 4px;">Value</th>
//                 </tr>`;
                
//             surroundingPointsForTooltip.forEach(p => {
//               // Highlight current point
//               const style = p.isCurrent ? 
//                 'background-color: #e6f3ff; font-weight: bold;' : '';
              
//               surroundingPointsHTML += `
//                 <tr style="${style}">
//                   <td style="text-align: right; padding: 2px 4px;">${p.index}</td>
//                   <td style="text-align: left; padding: 2px 4px; white-space: nowrap;">${p.timestamp.split(', ')[1]}</td>
//                   <td style="text-align: right; padding: 2px 4px;">${p.value !== null ? p.value.toFixed(2) : 'N/A'}</td>
//                 </tr>`;
//             });
            
//             surroundingPointsHTML += `</table></div>`;
            
//             // Add delta selection info if applicable
//             let deltaSelectionInfo = '';
//             if (this.selectionMode === 'second' && this.selectedPoint1) {
//               deltaSelectionInfo = `
//                 <div style="margin-top: 8px; padding: 5px; background-color: #fff8e1; border-radius: 4px; font-size: 12px;">
//                   <span style="font-weight: bold;">Delta Selection:</span> Point 1 selected. Click another point to calculate delta.
//                 </div>
//               `;
//             }
            
//             tooltipDiv.innerHTML = `
//               <div style="font-weight: bold; margin-bottom: 8px; font-size: 14px; color: #0066cc;">${channelName}</div>
//               <div style="margin-bottom: 4px;"><strong>Time:</strong> ${formattedDate}</div>
//               <div><strong>Value:</strong> ${tooltipValue}</div>
//               <div><strong>Original Value:</strong> ${originalValue}</div>
//               <div style="font-size: 10px; color: #666; margin-top: 5px;">Point ${nearestIndex} of ${points.length}</div>
//               ${deltaSelectionInfo}
//               ${surroundingPointsHTML}
//             `;
            
//             // Position the tooltip
//             tooltipDiv.style.left = (e.clientX + 10) + 'px';
//             tooltipDiv.style.top = (e.clientY - 25) + 'px';
//             tooltipDiv.style.opacity = '1';
            
//             // Keep the tooltip visible for longer (5 seconds)
//             if (this._tooltipTimeout) {
//               clearTimeout(this._tooltipTimeout);
//             }
            
//             // Highlight the point if possible
//             try {
//               this.chartInstance.dispatchAction({
//                 type: 'highlight',
//                 seriesIndex: seriesIndex,
//                 dataIndex: nearestIndex
//               });
//             } catch (highlightErr) {
//               console.log('Could not highlight point:', highlightErr);
//             }
            
//             // Store timeout ID for later clearing
//             this._tooltipTimeout = setTimeout(() => {
//               tooltipDiv.style.opacity = '0';
              
//               try {
//                 this.chartInstance.dispatchAction({
//                   type: 'downplay',
//                   seriesIndex: seriesIndex,
//                   dataIndex: nearestIndex
//                 });
//               } catch (downplayErr) {
//                 console.log('Could not downplay point:', downplayErr);
//               }
//             }, 5000); // Show for 5 seconds
//           }
//         }
//       } catch (err) {
//         console.error('Error processing tooltip:', err);
//       }
//     });
    
//     // Add zooming event handlers
//     this.chartInstance.on('datazoom', () => {
//       const option = this.chartInstance.getOption();
//       const startValue = option.dataZoom[0].startValue;
//       const endValue = option.dataZoom[0].endValue;
//       this.calculateVisiblePoints(startValue, endValue);
      
//       // Use throttled redraw instead of setTimeout
//       // this.throttledRedraw();
//     });
    
//     // Get renderer information 
//     const zr = this.chartInstance.getZr();
//     const renderer = zr.painter.type || ''; // Use .type instead of .getType()
//     console.log('ECharts is using renderer:', renderer);
    
//     // Check if hardware acceleration is enabled
//     const isHardwareAccelerated = this.isHardwareAccelerated();
//     console.log('Hardware acceleration is enabled:', isHardwareAccelerated);
    
//     // Check WebGL support
//     const canvas = document.createElement('canvas');
//     const gl = canvas.getContext('webgl') as WebGLRenderingContext | null || 
//               canvas.getContext('experimental-webgl') as WebGLRenderingContext | null;
//     console.log('WebGL supported by browser:', !!gl);
    
//     // If we want to use hardware acceleration but it's not currently enabled
//     if (this.useHardwareAcceleration && !isHardwareAccelerated && gl) {
//       console.log('Attempting to optimize for hardware acceleration');
      
//       // Try to force hardware acceleration with Canvas
//       const originalOptions = this.chartInstance.getOption();
//       const container = this.chartInstance.getDom();
      
//       // Store event handlers
//       const eventHandlers = this.chartInstance._$eventProcessor ? 
//                           this.chartInstance._$eventProcessor._$handlers : {};
      
//       try {
//         // Save the tooltip element reference
//         const savedTooltipDiv = tooltipDiv;
        
//         // Dispose of the current instance
//         this.chartInstance.dispose();
        
//         // Create a new instance with canvas renderer and optimal settings
//         this.chartInstance = echarts.init(container, null, {
//           renderer: 'canvas', // Use 'canvas' with hardware acceleration 
//           devicePixelRatio: window.devicePixelRatio || 1,
//           useDirtyRect: false, // Sometimes dirty rect causes issues with hardware acceleration
//           width: container.clientWidth,
//           height: container.clientHeight
//         });
        
//         // Set animation off for better performance
//         originalOptions.animation = false;
        
//         // Re-apply options
//         this.chartInstance.setOption(originalOptions);
        
//         // Reattach datazoom event handler
//         this.chartInstance.on('datazoom', (params: any) => {
//           const option = this.chartInstance.getOption();
//           const startValue = option.dataZoom[0].startValue;
//           const endValue = option.dataZoom[0].endValue;
//           this.calculateVisiblePoints(startValue, endValue);
//         });
        
//         // Re-attach our custom click handler after chart is re-created
//         container.addEventListener('click', (e: MouseEvent) => {
//           // Get mouse position relative to chart
//           const rect = container.getBoundingClientRect();
//           const x = e.clientX - rect.left;
//           const y = e.clientY - rect.top;
          
//           console.log('Chart clicked at point (after reinitialization):', x, y);
          
//           try {
//             // Calculate which series was clicked based on y position
//             const seriesIndex = Math.floor(y / (rect.height / this.selectedChannels.length));
//             console.log('Calculated seriesIndex:', seriesIndex);
            
//             if (seriesIndex >= 0 && seriesIndex < this.selectedChannels.length) {
//               const channelName = this.selectedChannels[seriesIndex];
//               const points = this.dataCache.get(channelName) || [];
              
//               if (points.length === 0) {
//                 console.log('No data points for channel:', channelName);
//                 return;
//               }
              
//               // Calculate x position as a percentage of chart width
//               const xPercent = x / rect.width;
              
//               // Calculate the approximate timestamp based on the range
//               const timeRange = this.timeRange[1] - this.timeRange[0];
//               const approximateTimestamp = this.timeRange[0] + (timeRange * xPercent);
              
//               console.log('Approximated timestamp:', new Date(approximateTimestamp).toLocaleString());
              
//               // Find the nearest point in time
//               let nearestIndex = -1;
//               let minDistance = Infinity;
              
//               for (let i = 0; i < points.length; i++) {
//                 const distance = Math.abs(points[i][0] - approximateTimestamp);
//                 if (distance < minDistance) {
//                   minDistance = distance;
//                   nearestIndex = i;
//                 }
//               }
              
//               if (nearestIndex >= 0) {
//                 const point = points[nearestIndex];
//                 console.log('Found nearest point:', point, 'at index:', nearestIndex);
                
//                 // Format the tooltip content
//                 const date = new Date(point[0]);
//                 const formattedDate = date.toLocaleString();
//                 const value = point[1] !== null ? point[1].toFixed(4) : 'N/A';
                
//                 savedTooltipDiv.innerHTML = `
//                   <div style="font-weight: bold; margin-bottom: 5px;">${channelName}</div>
//                   <div><strong>Time:</strong> ${formattedDate}</div>
//                   <div><strong>Value:</strong> ${value}</div>
//                 `;
                
//                 // Position the tooltip
//                 savedTooltipDiv.style.left = (e.clientX + 10) + 'px';
//                 savedTooltipDiv.style.top = (e.clientY - 25) + 'px';
//                 savedTooltipDiv.style.opacity = '1';
                
//                 // Highlight the point if possible
//                 try {
//                   this.chartInstance.dispatchAction({
//                     type: 'highlight',
//                     seriesIndex: seriesIndex,
//                     dataIndex: nearestIndex
//                   });
//                 } catch (highlightErr) {
//                   console.log('Could not highlight point:', highlightErr);
//                 }
                
//                 // Hide tooltip after 3 seconds
//                 setTimeout(() => {
//                   savedTooltipDiv.style.opacity = '0';
                  
//                   try {
//                     this.chartInstance.dispatchAction({
//                       type: 'downplay',
//                       seriesIndex: seriesIndex,
//                       dataIndex: nearestIndex
//                     });
//                   } catch (downplayErr) {
//                     console.log('Could not downplay point:', downplayErr);
//                   }
//                 }, 3000);
//               }
//             }
//           } catch (err) {
//             console.error('Error processing tooltip after reinitialization:', err);
//           }
//         });
        
//         // Check if hardware acceleration is now enabled
//         console.log('Hardware acceleration after optimization:', this.isHardwareAccelerated());
//       } catch (e) {
//         console.error('Failed to apply hardware acceleration optimizations:', e);
//       }
//     }
    
//     // Apply optimizations for canvas
//     if (renderer === 'canvas' && zr.painter) {
//       this.applyCanvasOptimizations(zr.painter);
//     }
//   }

// /**
//  * Marks a selected point on the chart
//  */
//   markSelectedPoint(pointNumber: number, seriesIndex: number, timestamp: number, value: number): void {
//     if (!this.chartInstance) return;
    
//     try {
//       // Make the markers more visible
//       const color = pointNumber === 1 ? '#ff3333' : '#3333ff'; // Brighter red and blue
      
//       // Get current chart options and check if series exists
//       const option = this.chartInstance.getOption();
//       if (!option.series || !option.series[seriesIndex]) {
//         console.error('Series not found at index:', seriesIndex);
//         return;
//       }
      
//       // Create markPoint data
//       const markPointData = [{
//         name: `Point ${pointNumber}`,
//         coord: [timestamp, value],
//         itemStyle: {
//           color: color
//         },
//         symbolSize: 15,
//         symbol: 'pin',
//         label: {
//           show: true,
//           formatter: `P${pointNumber}`,
//           position: 'top',
//           fontSize: 14,
//           color: color,
//           fontWeight: 'bold'
//         }
//       }];
      
//       // Update only the specific series for the point marker
//       const updateObj: any = {
//         series: {}
//       };
      
//       // Update only the specific series - use index as key
//       updateObj.series[seriesIndex] = {
//         markPoint: {
//           symbol: 'pin',
//           symbolSize: 15,
//           data: markPointData
//         }
//       };
      
//       this.chartInstance.setOption(updateObj);
      
      
//       console.log(`Marked point ${pointNumber} at series ${seriesIndex}, timestamp ${new Date(timestamp).toLocaleString()}, value ${value}`);
//     } catch (e) {
//       console.error('Error marking selected point:', e);
//     }
//   }


//   // Delta for Multi channels
//   calculateMultiChannelDeltas(): void {
//     if (!this.selectedPoint1 || !this.selectedPoint2 || !this.chartInstance) return;
    
//     const timestamp1 = this.selectedPoint1.timestamp;
//     const timestamp2 = this.selectedPoint2.timestamp;
//     const deltaX = timestamp2 - timestamp1;
//     const deltaTimeFormatted = this.formatTimeDelta(deltaX);
    
//     // Calculate delta for each visible channel
//     const channelDeltas = [];
    
//     for (const channelName of this.selectedChannels) {
//       // Get the data for this channel
//       const data = this.dataCache.get(channelName) || [];
      
//       if (data.length === 0) continue;
      
//       // Find nearest points for both timestamps
//       let value1 = null;
//       let value2 = null;
      
//       // Find nearest point to timestamp1
//       let minDistance1 = Infinity;
//       for (let i = 0; i < data.length; i++) {
//         const distance = Math.abs(data[i][0] - timestamp1);
//         if (distance < minDistance1) {
//           minDistance1 = distance;
//           value1 = data[i][1];
//         }
//       }
      
//       // Find nearest point to timestamp2
//       let minDistance2 = Infinity;
//       for (let i = 0; i < data.length; i++) {
//         const distance = Math.abs(data[i][0] - timestamp2);
//         if (distance < minDistance2) {
//           minDistance2 = distance;
//           value2 = data[i][1];
//         }
//       }
      
//       // Calculate delta if both values are found
//       if (value1 !== null && value2 !== null) {
//         const deltaY = value2 - value1;
//         channelDeltas.push({
//           channel: channelName,
//           value1: value1,
//           value2: value2,
//           deltaY: deltaY
//         });
        
//         // Draw delta line for this channel
//         this.drawChannelDeltaLine(channelName, timestamp1, value1, timestamp2, value2, deltaY);
//       }
//     }
    
//     // Store the multi-channel delta info
//     this.deltaInfo = {
//       deltaX,
//       deltaTimeFormatted,
//       channelDeltas: channelDeltas
//     };
    
//     this.showDeltaInfo = true;
    
//     // Update the delta info panel with multi-channel data
//     this.showMultiChannelDeltaInfoPanel();
//   }


//   // draw Channel Delta Line
//   drawChannelDeltaLine(channel: string, timestamp1: number, value1: number, 
//                     timestamp2: number, value2: number, deltaY: number): void {
//     if (!this.chartInstance) return;
    
//     const seriesIndex = this.findChannelSeriesIndex(channel);
//     if (seriesIndex === -1) return;
    
//     // Different colors for different channels
//     const colorMap: {[key: string]: string} = {
//       'Line_Voltage_2': '#0066cc',
//       'Snubber': '#00cc66',
//       'HF_Current': '#cc6600',
//       // Add colors for other channels
//     };
    
//     const color = colorMap[channel] || '#ff6600';
    
//     // Create markLine data
//     const markLineData = [{
//       name: `Delta_${channel}`,
//       coords: [
//         [timestamp1, value1],
//         [timestamp2, value2]
//       ],
//       lineStyle: {
//         color: color,
//         width: 2,
//         type: 'solid'
//       },
//       label: {
//         show: true,
//         position: 'middle',
//         formatter: `Δ = ${deltaY.toFixed(4)}`,
//         fontSize: 14,
//         backgroundColor: 'rgba(255, 255, 255, 0.7)',
//         padding: [4, 8],
//         borderRadius: 4
//       }
//     }];
    
//     // Update chart to show the delta line
//     const updateObj: any = {
//       series: {}
//     };
    
//     updateObj.series[seriesIndex] = {
//       markLine: {
//         silent: false,
//         symbol: ['circle', 'arrow'],
//         lineStyle: {
//           type: 'dashed',
//           width: 2,
//           color: color
//         },
//         data: markLineData
//       }
//     };
    
//     this.chartInstance.setOption(updateObj);
//   }

//   /**
//    * Formats time delta in human-readable format
//    */
//   formatTimeDelta(milliseconds: number): string {
//     const absMilliseconds = Math.abs(milliseconds);
//     const seconds = Math.floor(absMilliseconds / 1000);
//     const minutes = Math.floor(seconds / 60);
//     const hours = Math.floor(minutes / 60);
//     const days = Math.floor(hours / 24);
    
//     if (days > 0) {
//       return `${days}d ${hours % 24}h ${minutes % 60}m ${seconds % 60}s`;
//     } else if (hours > 0) {
//       return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
//     } else if (minutes > 0) {
//       return `${minutes}m ${seconds % 60}s`;
//     } else if (seconds > 0) {
//       return `${seconds}s ${absMilliseconds % 1000}ms`;
//     } else {
//       // Show milliseconds for very small differences
//       return `${absMilliseconds}ms`;
//     }
//   }

//   /**
//  * Helper to find the series index for a channel
//  */
//   findChannelSeriesIndex(channelName: string): number {
//     if (!this.chartInstance) return -1;
    
//     const option = this.chartInstance.getOption();
//     if (!option.series || !Array.isArray(option.series)) return -1;
    
//     for (let i = 0; i < option.series.length; i++) {
//       if (option.series[i].name === channelName) {
//         return i;
//       }
//     }
    
//     return -1;
//   }

//   /**
//    * Shows a temporary message to the user
//    */
//   showMessage(message: string): void {
//     console.log(message);
    
//     // Create a toast notification that's visible to the user
//     const toast = document.createElement('div');
//     toast.style.cssText = `
//       position: fixed;
//       bottom: 20px;
//       left: 50%;
//       transform: translateX(-50%);
//       background-color: rgba(0, 0, 0, 0.8);
//       color: white;
//       padding: 10px 20px;
//       border-radius: 4px;
//       z-index: 10000;
//       font-size: 14px;
//       font-weight: bold;
//     `;
//     toast.textContent = message;
//     document.body.appendChild(toast);
    
//     // Remove after 3 seconds
//     setTimeout(() => {
//       toast.style.opacity = '0';
//       toast.style.transition = 'opacity 0.5s ease';
//       setTimeout(() => toast.remove(), 500);
//     }, 3000);
//   }

//   // Show multi-channel delta info panel
//   showMultiChannelDeltaInfoPanel(): void {
//     if (!this.deltaInfo) return;
    
//     // Remove existing panel if it exists
//     const existingPanel = document.getElementById('delta-info-panel');
//     if (existingPanel) existingPanel.remove();
    
//     // Create a new panel with improved styling
//     const deltaInfoEl = document.createElement('div');
//     deltaInfoEl.id = 'delta-info-panel';
//     deltaInfoEl.style.cssText = `
//       position: fixed;
//       top: 80px;
//       right: 20px;
//       background-color: white;
//       border: 2px solid #0066cc;
//       border-radius: 8px;
//       padding: 15px;
//       box-shadow: 0 6px 16px rgba(0, 0, 0, 0.2);
//       z-index: 10000;
//       min-width: 280px;
//       max-width: 350px;
//       font-family: Arial, sans-serif;
//     `;
    
//     // Create header content
//     let content = `
//       <div style="font-weight: bold; color: #0066cc; margin-bottom: 10px; border-bottom: 1px solid #e6e6e6; padding-bottom: 8px; font-size: 16px;">
//         Delta Calculation Results
//       </div>
//       <div style="margin-bottom: 8px;">
//         <span style="font-weight: 500; color: #555; width: 120px; display: inline-block;">From:</span> 
//         <span style="color: #0077cc; font-weight: 500;">${new Date(this.selectedPoint1!.timestamp).toLocaleString()}</span>
//       </div>
//       <div style="margin-bottom: 8px;">
//         <span style="font-weight: 500; color: #555; width: 120px; display: inline-block;">To:</span> 
//         <span style="color: #0077cc; font-weight: 500;">${new Date(this.selectedPoint2!.timestamp).toLocaleString()}</span>
//       </div>
//       <div style="margin-bottom: 15px;">
//         <span style="font-weight: 500; color: #555; width: 120px; display: inline-block;">Time Difference:</span> 
//         <span style="color: #0077cc; font-weight: 500;">${this.deltaInfo.deltaTimeFormatted}</span>
//       </div>
//       <div style="margin-bottom: 15px; border-bottom: 1px solid #e6e6e6; padding-bottom: 8px;">
//         <span style="font-weight: bold; color: #555;">Channel Delta Values:</span>
//       </div>
//     `;
    
//     // Add each channel's delta values
//     if (this.deltaInfo.channelDeltas) {
//       this.deltaInfo.channelDeltas.forEach((delta: any) => {
//         content += `
//           <div style="margin-bottom: 12px;">
//             <div style="font-weight: 500; color: #444; margin-bottom: 4px;">${delta.channel}:</div>
//             <div style="padding-left: 10px; margin-bottom: 2px;">
//               <span style="color: #555; width: 90px; display: inline-block;">From Value:</span> 
//               <span style="color: #0077cc;">${delta.value1.toFixed(4)}</span>
//             </div>
//             <div style="padding-left: 10px; margin-bottom: 2px;">
//               <span style="color: #555; width: 90px; display: inline-block;">To Value:</span> 
//               <span style="color: #0077cc;">${delta.value2.toFixed(4)}</span>
//             </div>
//             <div style="padding-left: 10px; font-weight: 500;">
//               <span style="color: #555; width: 90px; display: inline-block;">Delta:</span> 
//               <span style="color: #0077cc; font-size: 14px;">Δ = ${delta.deltaY.toFixed(4)}</span>
//             </div>
//           </div>
//         `;
//       });
//     }
    
//     // Add clear button
//     content += `
//       <button id="clearDeltaBtn" style="width: 100%; padding: 8px; background-color: #f0f0f0; border: 1px solid #ccc; border-radius: 4px; cursor: pointer; font-weight: bold; color: #444;">
//         Clear Selection
//       </button>
//     `;
    
//     deltaInfoEl.innerHTML = content;
    
//     // Add to document
//     document.body.appendChild(deltaInfoEl);
    
//     // Add event listener to the button
//     document.getElementById('clearDeltaBtn')?.addEventListener('click', () => {
//       this.clearDeltaSelection();
//       deltaInfoEl.remove();
//     });
//   }

//   /**
//    * Clears delta selection and resets UI
//    */
//   clearDeltaSelection(): void {
//     this.selectedPoint1 = null;
//     this.selectedPoint2 = null;
//     this.selectionMode = 'first';
//     this.showDeltaInfo = false;
//     this.deltaInfo = null;
        
//     // Clear markPoints from all series
//     if (this.chartInstance) {
//       const option = this.chartInstance.getOption();
//       const updateObj: any = {
//         series: {}
//       };
      
//       // Clear markPoint from all series
//       for (let i = 0; i < this.selectedChannels.length; i++) {
//         const channelName = this.selectedChannels[i];
//         const seriesIndex = this.findChannelSeriesIndex(channelName);
        
//         if (seriesIndex !== -1) {
//           updateObj.series[seriesIndex] = {
//             markPoint: { data: [] }
//           };
//         }
//       }
      
//       this.chartInstance.setOption(updateObj);
//     }
    
//     // Remove delta info panel and indicators
//     const deltaInfoEl = document.getElementById('delta-info-panel');
//     if (deltaInfoEl) {
//       deltaInfoEl.remove();
//     }
    
//     const deltaIndicator = document.getElementById('delta-mode-indicator');
//     if (deltaIndicator) {
//       deltaIndicator.remove();
//     }
//   }

// // Add this new method to update the delta mode indicator
//   updateDeltaModeIndicator(): void {
//     // Remove existing indicator if present
//     const existingIndicator = document.getElementById('delta-mode-indicator');
//     if (existingIndicator) existingIndicator.remove();
    
//     // If we're in second point selection mode, show the indicator
//     if (this.selectionMode === 'second' && this.selectedPoint1) {
//       const indicator = document.createElement('div');
//       indicator.id = 'delta-mode-indicator';
//       indicator.style.cssText = `
//         position: fixed;
//         top: 10px;
//         left: 50%;
//         transform: translateX(-50%);
//         background-color: #fff8e1;
//         border: 1px solid #ffecb3;
//         border-radius: 4px;
//         padding: 8px 16px;
//         z-index: 1000;
//         font-size: 14px;
//         box-shadow: 0 2px 8px rgba(0,0,0,0.1);
//       `;
//       indicator.innerHTML = `
//         <div style="display: flex; align-items: center; gap: 8px;">
//           <span style="color: #ff0000; font-weight: bold;">•</span>
//           <span>Point 1 selected. Click on second point to calculate delta.</span>
//         </div>
//       `;
//       document.body.appendChild(indicator);
//     }
//   }


// // Add this new method to separate the optimizations
//   applyCanvasOptimizations(painter: any): void {
//     console.log('Applying performance optimizations for Canvas renderer');
    
//     // Set chart animation to false for better performance
//     if (this.chartInstance) {
//       const opts = this.chartInstance.getOption();
//       if (opts) {
//         const optimizedOptions = {
//           animation: false,
//           animationThreshold: 1, // Lower threshold for animations
//           progressive: this.performanceSettings.progressiveThreshold,
//           progressiveThreshold: this.performanceSettings.progressiveThreshold,
//           hoverLayerThreshold: Infinity // Disable hover layer for large datasets
//         };
        
//         this.chartInstance.setOption(optimizedOptions, false); // Don't merge
//       }
//     }
    
//     // Enable canvas optimizations if we have access to the context
//     try {
//       // For Canvas renderer we can optimize these settings
//       if (painter.ctx) {
//         // Set image smoothing to false for better performance
//         const ctx = painter.ctx;
//         ctx.imageSmoothingEnabled = false;
//         ctx.mozImageSmoothingEnabled = false;
//         ctx.webkitImageSmoothingEnabled = false;
//         ctx.msImageSmoothingEnabled = false;
        
//         console.log('Canvas optimizations applied');
//       }
//     } catch (e) {
//       console.warn('Failed to optimize canvas rendering:', e);
//     }
//   }

//   // Debug method to verify channel data matches
//   verifyChannelData(): void {
//     console.log('Selected channels:', this.selectedChannels);
    
//     for (const channel of this.selectedChannels) {
//       const data = this.dataCache.get(channel);
//       if (data && data.length > 0) {
//         console.log(`${channel} data sample:`, data[0], data[Math.floor(data.length/2)], data[data.length-1]);
//       } else {
//         console.log(`${channel} has no data or is not in cache`);
//       }
//     }
    
//     console.log('Series mapping in chart:');
//     const series = this.chartInstance.getOption().series;
//     for (let i = 0; i < series.length; i++) {
//       console.log(`Series ${i}: ${series[i].name}`);
//     }
//   }

//   // Add this helper method to check for hardware acceleration
//   isHardwareAccelerated(): boolean {
//     const canvas = document.createElement('canvas');
//     const ctx = canvas.getContext('2d');
    
//     if (!ctx) return false;
    
//     // Check for specific properties that indicate hardware acceleration
//     try {
//       // @ts-ignore: Property may not exist
//       return !!(ctx.getContextAttributes && ctx.getContextAttributes().alpha);
//     } catch (e) {
//       // Fallback detection method
//       try {
//         const gl = document.createElement('canvas').getContext('webgl');
//         if (!gl) return false;
        
//         const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
//         if (!debugInfo) return false;
        
//         const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
//         return !renderer.includes('SwiftShader') && 
//               !renderer.includes('llvmpipe') && 
//               !renderer.includes('software');
//       } catch (e) {
//         return false;
//       }
//     }
//   }
  
//   setupPerformancePreset(): void {
//     // Always use speed-optimized settings
//     this.performanceSettings = {
//       useProgressive: true,
//       progressiveThreshold: 5000,
//       progressiveChunkSize: 2000,
//       largeThreshold: 2000,
//       throttle: 30,
//       piecewiseLevels: [100, 500, 1000, 5000]
//     };
    
//     // Apply WebGL specific optimizations
//     if (this.chartInstance) {
//       const zr = this.chartInstance.getZr();
//       // Check if it's canvas renderer, we can still optimize
//       if (zr.painter) {
//         try {
//           zr.painter.configLayer && zr.painter.configLayer(0, {
//             clearDepth: 1,
//             clearColor: [0, 0, 0, 0],
//             renderToTexture: true,
//             blendFunc: [770, 771] // SRC_ALPHA, ONE_MINUS_SRC_ALPHA
//           });
//         } catch (e) {
//           console.log('Unable to configure layer:', e);
//         }
//       }
//     }
    
//     // Set renderer options for high performance
//     this.initOpts = {
//       renderer: 'canvas',
//       width: 'auto',
//       height: 'auto',
//       useDirtyRect: true,
//       devicePixelRatio: window.devicePixelRatio || 1
//     };
    
//     // If chart is already initialized, we need to update
//     if (this.chartInstance && this.chartInstance.getZr()) {
//       // Apply performance options to the existing chart
//       const opts = this.chartInstance.getOption();
//       if (opts) {
//         const optimizedOptions = {
//           animation: false,
//           animationThreshold: 1,
//           progressive: this.performanceSettings.progressiveThreshold,
//           progressiveThreshold: this.performanceSettings.progressiveThreshold,
//           hoverLayerThreshold: Infinity
//         };
        
//         this.chartInstance.setOption(optimizedOptions, false);
//       }
//     }
//   }

  
//   loadCsvData(): void {
//     this.loading = true;
//     this.error = null;
//     this.progress = 0;
//     this.clearCaches();
//     this.rawDataChunks = [];
    
//     const startTime = performance.now();
    
//     // Use HTTP request with progress events
//     this.http.get(this.csvFilePath, {
//       responseType: 'text',
//       reportProgress: true,
//       observe: 'events'
//     }).subscribe({
//       next: (event) => {
//         if (event.type === HttpEventType.DownloadProgress) {
//           const progressEvent = event as HttpProgressEvent;
//           if (progressEvent.total) {
//             this.progress = Math.round((progressEvent.loaded / progressEvent.total) * 50);
//             this.cdr.detectChanges();
//           }
//         } else if (event.type === HttpEventType.Response) {
//           const csvText = event.body as string;
//           this.processCSV(csvText, startTime);
//         }
//       },
//       error: (err) => {
//         console.error('CSV load error:', err);
//         this.error = `Load error: ${err.message || 'Could not load CSV file'}`;
//         this.loading = false;
//         this.cdr.detectChanges();
//       }
//     });
//   }

//   processCSV(csvText: string, startTime: number): void {
//     if (!csvText || csvText.trim() === '') {
//       this.error = 'CSV file is empty';
//       this.loading = false;
//       this.cdr.detectChanges();
//       return;
//     }
    
//     // Extract headers
//     const firstRow = csvText.split('\n')[0];
//     if (!firstRow) {
//       this.error = 'CSV file has no headers';
//       this.loading = false;
//       this.cdr.detectChanges();
//       return;
//     }
    
//     // Parse headers and set up columns
//     const hdrs = firstRow.split(',').map(h => h.trim());
//     this.columns = hdrs.slice(1); // Assuming first column is TimeStamp
    
//     // Auto-select first two channels if none are selected
//     if (!this.selectedChannels.length && this.columns.length) {
//       this.selectedChannels = this.columns.slice(0, Math.min(2, this.columns.length));
//     }
    
//     const total = csvText.split('\n').length;
//     this.totalPoints = (total - 1) * this.columns.length; // -1 for header row
    
//     let chunkSize = 5000; // Process in chunks to avoid blocking UI
//     let chunkStart = 0;
//     let currentChunk: any[] = [];
//     let minTimestamp = Infinity;
//     let maxTimestamp = -Infinity;
    
//     console.log(`Processing ${total} rows of CSV data...`);
    
//     // Function to process chunks with setTimeout to avoid blocking UI
//     const processChunk = () => {
//       const chunkEnd = Math.min(chunkStart + chunkSize, total);
//       currentChunk = [];
      
//       // Parse the current chunk
//       parse(csvText.slice(
//         csvText.indexOf('\n', chunkStart) + 1,
//         chunkEnd < total ? csvText.indexOf('\n', chunkEnd) : undefined
//       ), {
//         header: false,
//         skipEmptyLines: true,
//         dynamicTyping: true,
//         complete: (results: ParseResult<any>) => {
//           for (const row of results.data) {
//             if (row && row.length > 1) {
//               const processedRow: any = { TimeStamp: row[0] };
              
//               // Convert TimeStamp once and cache it
//               const ts = this.parseTimestamp(row[0]);
//               if (!isNaN(ts)) {
//                 processedRow._parsedTimestamp = ts;
                
//                 // Update time range
//                 minTimestamp = Math.min(minTimestamp, ts);
//                 maxTimestamp = Math.max(maxTimestamp, ts);
//               }
              
//               // Process each column
//               for (let i = 0; i < this.columns.length; i++) {
//                 processedRow[this.columns[i]] = row[i + 1];
//               }
              
//               currentChunk.push(processedRow);
//             }
//           }
          
//           // Add the chunk to our chunks array
//           if (currentChunk.length > 0) {
//             this.rawDataChunks.push(currentChunk);
//           }
          
//           // Update progress
//           this.progress = 50 + Math.round((chunkEnd / total) * 50);
//           this.cdr.detectChanges();
          
//           // Continue with next chunk or finish
//           chunkStart = chunkEnd;
//           if (chunkStart < total) {
//             setTimeout(processChunk, 0);
//           } else {
//             this.timeRange = [minTimestamp, maxTimestamp];
//             this.loading = false;
//             this.loadComplete = true;
            
//             const endTime = performance.now();
//             this.timingReport = `CSV loaded in ${((endTime - startTime) / 1000).toFixed(2)}s`;
//             console.log(`CSV processing complete. ${this.rawDataChunks.reduce((sum, chunk) => sum + chunk.length, 0)} rows in ${this.rawDataChunks.length} chunks.`);
            
//             // Update chart after data is loaded
//             this.dataChanged$.next(true);
//           }
//         },
//         error: (err: any) => {
//           console.error('CSV parse error while processing chunk:', err);
//           this.error = `Parse error: ${err.message}`;
//           this.loading = false;
//           this.cdr.detectChanges();
//         }
//       });
//     };
    
//     // Start processing chunks
//     processChunk();
//   }
  
//   parseTimestamp(ts: string | number): number {
//     if (ts === null || ts === undefined) return NaN;
    
//     // Check cache first
//     if (typeof ts === 'string' && this.timestampCache.has(ts)) {
//       return this.timestampCache.get(ts)!;
//     }
    
//     try {
//       // Already a number
//       if (typeof ts === 'number') return ts;
      
//       let timestamp: number;
      
//       // Handle your specific format: DD-MM-YYYY HH:MM:SS:MMM.SSSSSS
//       if (ts.includes('-') && ts.includes(':')) {
//         const [datePart, timePart] = ts.split(' ');
        
//         // Parse date as DD-MM-YYYY
//         const [day, month, year] = datePart.split('-').map(Number);
        
//         // Handle the complex time format
//         const timeSegments = timePart.split(':');
//         const hours = parseInt(timeSegments[0], 10);
//         const minutes = parseInt(timeSegments[1], 10);
//         const seconds = parseInt(timeSegments[2], 10);
        
//         // Handle milliseconds.microseconds
//         let milliseconds = 0;
//         if (timeSegments.length > 3 && timeSegments[3].includes('.')) {
//           const [millis, micros] = timeSegments[3].split('.');
//           milliseconds = parseInt(millis, 10);
//         } else if (timeSegments.length > 3) {
//           milliseconds = parseInt(timeSegments[3], 10);
//         }
        
//         timestamp = new Date(year, month - 1, day, hours, minutes, seconds, milliseconds).getTime();
//       } else if (ts.includes('T') || ts.includes('Z')) {
//         // ISO format
//         timestamp = new Date(ts).getTime();
//       } else {
//         // Try as a regular date string
//         timestamp = new Date(ts).getTime();
//       }
      
//       // Store in cache
//       if (!isNaN(timestamp) && typeof ts === 'string') {
//         this.timestampCache.set(ts, timestamp);
//       }
      
//       return timestamp;
//     } catch (e) {
//       console.warn('Error parsing timestamp:', ts, e);
//       return NaN;
//     }
//   }

//   // Helper method to find original data in raw chunks
//   findRawDataIndex(channelName: string, timestamp: number): { chunk: number, row: number } {
//     // Look for a close match in raw data chunks
//     for (let chunkIndex = 0; chunkIndex < this.rawDataChunks.length; chunkIndex++) {
//       const chunk = this.rawDataChunks[chunkIndex];
      
//       for (let rowIndex = 0; rowIndex < chunk.length; rowIndex++) {
//         const row = chunk[rowIndex];
        
//         // Compare parsed timestamps
//         if (Math.abs(row._parsedTimestamp - timestamp) < 1) { // Within 1ms
//           console.log('Found matching raw data:', row);
//           return { chunk: chunkIndex, row: rowIndex };
//         }
//       }
//     }
    
//     return { chunk: -1, row: -1 };
//   }
    
//   isChannelSelected(ch: string): boolean {
//     return this.selectedChannels.includes(ch);
//   }
  
//   toggleChannel(ch: string): void {
//     const idx = this.selectedChannels.indexOf(ch);
//     if (idx === -1) {
//       this.selectedChannels.push(ch);
//     } else {
//       this.selectedChannels.splice(idx, 1);
//     }
    
//     // Remove from cache any datasets for channels no longer selected
//     if (idx !== -1) {
//       this.dataCache.delete(ch);
//     }
    
//     this.dataChanged$.next(true);
//   }
  
//   calculateVisiblePoints(startTime: number, endTime: number): void {
//     if (!startTime || !endTime) {
//       this.visiblePoints = this.totalPoints;
//       return;
//     }
    
//     // Calculate percentage of data visible
//     const totalTimeRange = this.timeRange[1] - this.timeRange[0];
//     const visibleTimeRange = endTime - startTime;
//     const visibleRatio = visibleTimeRange / totalTimeRange;
    
//     // Approximate visible points
//     const channelCount = this.selectedChannels.length;
//     const totalPointsPerChannel = this.rawDataChunks.reduce((sum, chunk) => sum + chunk.length, 0);
//     this.visiblePoints = Math.round(totalPointsPerChannel * visibleRatio * channelCount);
//   }
  
//   updateChartData(): void {
//     if (!this.loadComplete || !this.selectedChannels.length || this.rawDataChunks.length === 0) return;
    
//     console.time('chartUpdate');
    
//     // Performance optimization: prepare channel data only once and cache it
//     this.prepareChannelDatasets();
    
//     // Always use stacked chart
//     this.createStackedChart();
    
//     console.timeEnd('chartUpdate');
    
//     // Force update of chart if instance exists
//     if (this.chartInstance) {
//       this.chartInstance.setOption(this.chartOption, {
//         notMerge: true,
//         lazyUpdate: true
//       });
      
//       // Debug series mapping
//       this.verifyChannelData();

//       // Use throttled redraw
//       // this.throttledRedraw();
//     }
//   }
  
//   checkRendererCapability(): void {
//   const canvas = document.createElement('canvas');
//   const gl = canvas.getContext('webgl') as WebGLRenderingContext | null || 
//             canvas.getContext('experimental-webgl') as WebGLRenderingContext | null;
            
//   if (!gl) {
//     console.warn('WebGL not supported by this browser - falling back to standard Canvas renderer');
//     // Fall back to canvas renderer (this is already the default)
//     this.initOpts.renderer = 'canvas';
//     return;
//   }
  
//   // Check for any WebGL limitations that might cause problems
//   const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
//   console.log('WebGL max texture size:', maxTextureSize);
  
//   if (maxTextureSize < 4096) {
//     console.warn('WebGL texture size limited - might affect performance for large datasets');
//   }
  
//   // Try to detect if running in a virtual environment
//   try {
//     const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
//     if (debugInfo) {
//       const vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
//       const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
//       console.log('GPU Vendor:', vendor);
//       console.log('GPU Renderer:', renderer);
      
//       // Detect virtual environments or software renderers
//       const isVirtualGPU = renderer.toLowerCase().includes('llvmpipe') || 
//                           renderer.toLowerCase().includes('swiftshader') ||
//                           renderer.toLowerCase().includes('virtualbox') ||
//                           renderer.toLowerCase().includes('vmware');
                          
//       if (isVirtualGPU) {
//         console.warn('Virtual GPU detected, performance may be limited');
//       }
//     }
//   } catch (e) {
//     console.warn('Unable to get detailed GPU info');
//   }
  
//   // Keep canvas as the renderer, but we'll enable hardware acceleration optimizations
//   this.initOpts.renderer = 'canvas'; // Change from 'webgl' to 'canvas'
  
//   // Set flag to indicate we should use hardware acceleration optimizations
//   this.useHardwareAcceleration = true;
//   console.log('Hardware acceleration will be used with Canvas renderer');
// }


//   prepareChannelDatasets(): void {
//     // Only prepare datasets for channels that aren't already cached
//     const channelsToProcess = this.selectedChannels.filter(ch => !this.dataCache.has(ch));
    
//     if (channelsToProcess.length === 0) return;
    
//     console.time('dataPreparation');
    
//     // Process each channel that needs processing
//     for (const channel of channelsToProcess) {
//       const data: Array<[number, number | null]> = [];
      
//       // Process all chunks for this channel
//       for (const chunk of this.rawDataChunks) {
//         for (const row of chunk) {
//           const timestamp = row._parsedTimestamp || this.parseTimestamp(row.TimeStamp);
//           if (!isNaN(timestamp)) {
//             const value = row[channel];
//             data.push([timestamp, value !== null && value !== undefined ? value : null]);
//           }
//         }
//       }
      
//       // Sort by timestamp (important for line charts)
//       data.sort((a, b) => a[0] - b[0]);
      
//       // Store in cache
//       this.dataCache.set(channel, data);
//     }
    
//     console.timeEnd('dataPreparation');
//     console.log(`Prepared data for ${channelsToProcess.length} channels`);
//   }
  
//   createStackedChart(): void {
//     const channelCount = this.selectedChannels.length;
//     const gridHeightPercentage = Math.min(85 / channelCount, 25);
    
//     // Create grids for each channel with improved spacing
//     const grids = this.selectedChannels.map((_, i) => ({
//       left: 70,  // Increase left margin for y-axis labels
//       right: 70, // Increase right margin 
//       top: `${10 + i * gridHeightPercentage}%`,
//       height: `${gridHeightPercentage - 2}%`, // Reduce height slightly for better spacing
//       containLabel: true,
//       z: 50 + i
//     }));
    
//     // X axes configuration with improved formatting
//     const xAxes = this.selectedChannels.map((_, i) => ({
//       type: 'time',
//       gridIndex: i,
//       scale: true,
//       axisLabel: {
//         show: i === channelCount - 1, // Only show on last grid
//         formatter: (value: number) => {
//           return new Date(value).toLocaleString('en-US', {
//             month: 'short',
//             day: '2-digit',
//             hour: '2-digit',
//             minute: '2-digit'
//           });
//         },
//         hideOverlap: true,
//         fontSize: 11,  // Smaller font size
//         margin: 12     // Increase margin
//       },
//       splitLine: {
//         show: true,
//         lineStyle: {
//           type: 'dashed',
//           opacity: 0.2
//         }
//       },
//       min: this.timeRange[0],
//       max: this.timeRange[1]
//     }));
    
//     // Y axes configuration with improved formatting
//     const yAxes = this.selectedChannels.map((ch, i) => ({
//       type: 'value',
//       gridIndex: i,
//       name: ch,
//       nameLocation: 'middle',
//       nameGap: 50,    // Increase gap for better readability
//       nameTextStyle: {
//         fontSize: 12,
//         fontWeight: 'bold',
//         align: 'right',
//         padding: [0, 0, 0, 10] // Add padding to the name
//       },
//       scale: true,
//       axisLabel: {
//         fontSize: 11,
//         formatter: (value: number) => {
//           // Format large numbers for better readability
//           if (Math.abs(value) >= 1000) {
//             return (value / 1000).toFixed(1) + 'k';
//           }
//           return value.toFixed(value % 1 === 0 ? 0 : 1);
//         }
//       },
//       splitLine: {
//         show: true,
//         lineStyle: {
//           type: 'dashed',
//           opacity: 0.2
//         }
//       }
//     }));
    
//     // Series configuration with improved styling
//     const series = this.selectedChannels.map((ch, i) => {
//       const data = this.dataCache.get(ch) || [];
      
//       return {
//         name: ch,
//         type: 'line',
//         xAxisIndex: i,
//         yAxisIndex: i,
//         data: data,
//         showSymbol: false, // Always hide symbols for better performance
//         large: true,
//         largeThreshold: 2000, // Set to a reasonable value for performance
//         progressive: 5000,   // Fixed value for progressive rendering
//         progressiveThreshold: 5000,
//         progressiveChunkMode: 'sequential',
//         progressiveChunkSize: 2000,
//         animation: false,    // Disable animation for better performance
//         lineStyle: {
//           width: 1.5,        // Slightly thicker lines for better visibility
//           color: this.getColorForChannel(i), // Add custom colors per channel
//           join: 'bevel'
//         },
//         itemStyle: {
//           borderWidth: 1.5
//         }
//       };
//     });
    
//     // Create the chart option with improved configuration
//     this.chartOption = {
//       title: {
//         text: `Time Series Data Visualization (${this.totalPoints.toLocaleString()} points)`,
//         left: 'center',
//         top: 5,
//         textStyle: {
//           fontSize: 16,
//           fontWeight: 'bold'
//         }
//       },
//       tooltip: {
//         show: false, // Turn off ECharts built-in tooltip
//         triggerOn: 'none'
//       },
//       toolbox: {
//         feature: {
//           dataZoom: { 
//             yAxisIndex: 'none',
//             xAxisIndex: xAxes.map((_, i) => i),
//             icon: {
//               zoom: 'path://M0,13.5h26.9 M13.5,26.9V0 M32.1,13.5H58V58H13.5 V32.1',
//               back: 'path://M22,1.4L9.9,13.5l12.3,12.3 M10.3,13.5H54.9v44.6 H10.3v-26'
//             }
//           },
//           restore: {},
//           saveAsImage: {}
//         },
//         right: 10,
//         top: 10
//       },
//       dataZoom: [
//         {
//           type: 'slider',
//           xAxisIndex: xAxes.map((_, i) => i),
//           start: 0,
//           end: 100,
//           bottom: 10,
//           height: 25,
//           borderColor: '#ccc',
//           fillerColor: 'rgba(30,144,255,0.15)',
//           throttle: 30, // Lower throttle for more responsive zooming
//           handleIcon: 'path://M10.7,11.9v-1.3H9.3v1.3c-4.9,0.3-8.8,4.4-8.8,9.4c0,5,3.9,9.1,8.8,9.4v1.3h1.3v-1.3c4.9-0.3,8.8-4.4,8.8-9.4C19.5,16.3,15.6,12.2,10.7,11.9z M13.3,24.4H6.7V23h6.6V24.4z M13.3,19.6H6.7v-1.4h6.6V19.6z',
//           handleSize: '80%',
//           handleStyle: {
//             color: '#fff',
//             shadowBlur: 3,
//             shadowColor: 'rgba(0, 0, 0, 0.6)',
//             shadowOffsetX: 2,
//             shadowOffsetY: 2
//           }
//         },
//         {
//           type: 'inside',
//           xAxisIndex: xAxes.map((_, i) => i),
//           throttle: 30, // Lower throttle for more responsive zooming
//           zoomOnMouseWheel: true,
//           moveOnMouseMove: true
//         }
//       ],
//       grid: grids,
//       xAxis: xAxes,
//       yAxis: yAxes,
//       series: series,
//       // Add visual map for better data point coloring
//       visualMap: {
//         show: false,
//         dimension: 1, // Use y-axis value for color mapping
//         seriesIndex: series.map((_, i) => i),
//         inRange: {
//           color: series.map((_, i) => this.getColorForChannel(i))
//         }
//       }
//     };
//   }

//   // Add this new method to generate custom colors for channels
//   getColorForChannel(index: number): string {
//     // A set of pleasant colors that work well for time series
//     const colors = [
//       '#5470c6', '#91cc75', '#fac858', '#ee6666', 
//       '#73c0de', '#3ba272', '#fc8452', '#9a60b4',
//       '#ea7ccc', '#4ec1cb', '#4d7f3e', '#6b4c9a'
//     ];
    
//     return colors[index % colors.length];
//   }
  
//   selectAllChannels(): void {
//     this.selectedChannels = [...this.columns];
//     this.dataChanged$.next(true);
//   }
  
//   deselectAllChannels(): void {
//     this.selectedChannels = [];
//     this.dataChanged$.next(true);
//   }
  
  
//   exportData(): void {
//     if (!this.selectedChannels.length || this.rawDataChunks.length === 0) return;
    
//     // 1) Headers
//     const headers = ['TimeStamp', ...this.selectedChannels].join(',');
    
//     // 2) One output line per data point
//     const lines: string[] = [];
//     let rowCount = 0;
    
//     for (const chunk of this.rawDataChunks) {
//       for (const row of chunk) {
//         if (rowCount >= 1000000) {
//           console.warn('Export limited to 1 million rows to avoid browser crashes');
//           break;
//         }
        
//         // Use the original timestamp string (row.TimeStamp)
//         const vals = this.selectedChannels.map(ch => {
//           const val = row[ch];
//           // Handle numbers, strings, and null/undefined
//           if (val === null || val === undefined) return '';
//           return val;
//         });
        
//         lines.push([row.TimeStamp, ...vals].join(','));
//         rowCount++;
//       }
//     }
    
//     // 3) Combine and download
//     const csv = [headers, ...lines].join('\n');
//     const blob = new Blob([csv], { type: 'text/csv' });
//     const url = URL.createObjectURL(blob);
//     const a = document.createElement('a');
//     a.href = url;
//     a.download = 'time_series_export.csv';
//     a.click();
//     setTimeout(() => URL.revokeObjectURL(url), 100);
//   }
  
//   clearCaches(): void {
//     // Free memory by clearing caches
//     this.dataCache.clear();
//     this.timestampCache.clear();
//   }
  

// }
