# Angular EChart WebGL - CSV Time Series Visualization

A high-performance Angular application for visualizing and analyzing large CSV time series datasets with multiple channels. Built with Angular 19, ECharts, and optimized for handling millions of data points with real-time GPU monitoring.

## 🚀 Features

### Core Functionality
- **CSV Time Series Visualization**: Load and visualize CSV files with timestamp-based data
- **Multi-Channel Support**: Display multiple data channels simultaneously in a stacked view
- **Interactive Chart**: Click on data points to view detailed information and calculate deltas
- **Delta Calculation**: Select two points to calculate time and value differences across all channels
- **Data Export**: Export selected channels to CSV format
- **Progressive Loading**: Efficiently handle large datasets with chunked processing
- **Performance Optimizations**: Data caching, throttled updates, and hardware acceleration support

### User Interface
- **Channel Selection Panel**: Select/deselect channels with bulk actions (Select All, Deselect All)
- **Status Panel**: View selected channels, total data points, and visible data points
- **Interactive Tooltips**: Detailed point information with surrounding data context
- **Loading States**: Progress indicators during data processing
- **Error Handling**: User-friendly error messages with retry functionality

### Technical Features
- **GPU Monitoring**: Real-time FPS and render time monitoring via WebGL
- **Hardware Acceleration**: Canvas renderer with hardware acceleration optimizations
- **Responsive Design**: Adapts to different screen sizes
- **Memory Efficient**: Smart caching and cleanup of unused channel data

## 📋 Prerequisites

- **Node.js**: Version 18.x or higher
- **npm**: Version 9.x or higher (comes with Node.js)
- **Angular CLI**: Version 19.2.9 or higher

## 🛠️ Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd angular-echart-web-gl
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Prepare CSV data**
   - Place your CSV file in `src/assets/` directory
   - The default expected file is `src/assets/1UChannelsData.csv`
   - CSV format: First column should be `TimeStamp`, followed by channel columns

## 🎯 Usage

### Development Server

Start the development server:

```bash
ng serve
```

Navigate to `http://localhost:4200/`. The application will automatically reload when you modify source files.

### Building for Production

Build the project:

```bash
ng build
```

The build artifacts will be stored in the `dist/angular-echart-web-gl/` directory. The production build optimizes the application for performance and speed.

### Running Unit Tests

Execute unit tests with Karma:

```bash
ng test
```

## 📁 Project Structure

```
angular-echart-web-gl/
├── src/
│   ├── app/
│   │   ├── app.component.ts          # Main component with chart logic
│   │   ├── app.component.html        # Main template
│   │   ├── app.component.scss        # Component styles
│   │   ├── gpu-monitor.service.ts    # GPU monitoring service
│   │   ├── app.config.ts             # Application configuration
│   │   └── app.routes.ts             # Routing configuration
│   ├── assets/                       # Static assets (place CSV files here)
│   ├── index.html                    # Main HTML file
│   ├── main.ts                       # Application bootstrap
│   └── styles.scss                   # Global styles
├── angular.json                      # Angular CLI configuration
├── package.json                      # Dependencies and scripts
└── tsconfig.json                     # TypeScript configuration
```

## 📊 CSV Data Format

The application expects CSV files with the following format:

```csv
TimeStamp,Channel1,Channel2,Channel3,...
2024-01-01 00:00:00,1.23,4.56,7.89,...
2024-01-01 00:00:01,1.24,4.57,7.90,...
...
```

**Requirements:**
- First column must be `TimeStamp` (case-sensitive)
- Timestamp format: Any format parseable by JavaScript `Date` constructor
- Subsequent columns are treated as data channels
- Missing values are handled gracefully (null/undefined)

**Default File Location:**
- `src/assets/1UChannelsData.csv`

To use a different file, modify `csvFilePath` in `app.component.ts`:

```typescript
csvFilePath = 'assets/your-file.csv';
```

## 🎨 Key Features Explained

### Channel Selection
- Use checkboxes to select/deselect channels for visualization
- "Select All" and "Deselect All" buttons for bulk operations
- Selected channels are displayed in a stacked view with individual grids

### Delta Calculation
1. Click on any data point in the chart (first point)
2. Click on another data point (second point)
3. The application calculates:
   - Time difference (delta X) between the two points
   - Value difference (delta Y) for each selected channel
   - Formatted time delta display

### Data Export
- Click "Export CSV" button to download selected channels
- Exports include timestamp and all selected channel values
- Limited to 1 million rows to prevent browser crashes

### Performance Optimizations
- **Progressive Rendering**: Large datasets are processed in chunks
- **Data Caching**: Channel data is cached to avoid reprocessing
- **Throttled Updates**: Chart updates are debounced to prevent excessive redraws
- **Hardware Acceleration**: Canvas renderer with GPU optimizations

## 🔧 Configuration

### Performance Settings

Adjust performance settings in `app.component.ts`:

```typescript
performanceSettings: PerformanceSettings = {
  useProgressive: true,           // Enable progressive rendering
  progressiveThreshold: 5000,     // Threshold for progressive mode
  progressiveChunkSize: 3000,     // Chunk size for progressive rendering
  largeThreshold: 2000,           // Threshold for large dataset handling
  throttle: 100,                   // Throttle time in milliseconds
  piecewiseLevels: [500, 1000, 5000, 10000]  // Data zoom levels
};
```

### GPU Monitoring

The application includes a GPU monitoring service that tracks:
- FPS (Frames Per Second)
- Render time
- GPU availability

GPU stats are available via the `GPUMonitorService` and can be displayed in the UI.

## 📦 Dependencies

### Core Dependencies
- **@angular/core**: ^19.2.0 - Angular framework
- **echarts**: ^5.6.0 - Charting library
- **echarts-gl**: ^2.0.9 - WebGL support for ECharts
- **ngx-echarts**: ^19.0.0 - Angular wrapper for ECharts
- **papaparse**: ^5.5.2 - CSV parsing library
- **rxjs**: ~7.8.0 - Reactive programming

### Development Dependencies
- **@angular/cli**: ^19.2.9 - Angular CLI
- **typescript**: ~5.7.2 - TypeScript compiler
- **karma**: ~6.4.0 - Test runner
- **jasmine**: ~5.6.0 - Testing framework

## 🐛 Troubleshooting

### CSV File Not Loading
- Ensure the CSV file is in `src/assets/` directory
- Check that the file path in `app.component.ts` matches your file location
- Verify the CSV has a `TimeStamp` column as the first column

### Performance Issues
- Reduce the number of selected channels
- Adjust `progressiveChunkSize` for better performance
- Check browser console for WebGL support warnings
- Consider reducing dataset size for initial testing

### Chart Not Displaying
- Check browser console for errors
- Verify CSV data is properly formatted
- Ensure at least one channel is selected
- Check that timestamps are valid dates

## 🔄 Code Scaffolding

Angular CLI includes powerful code scaffolding tools:

```bash
# Generate a new component
ng generate component component-name

# Generate a new service
ng generate service service-name

# Generate a new directive
ng generate directive directive-name

# See all available schematics
ng generate --help
```

## 📝 Browser Compatibility

- **Chrome/Edge**: Full support (recommended)
- **Firefox**: Full support
- **Safari**: Full support (WebGL may have limitations)
- **Opera**: Full support

**Note**: WebGL support is required for optimal GPU monitoring. The application will fall back to Canvas renderer if WebGL is not available.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is private and proprietary.

## 👨‍💻 Development Notes

### Architecture
- **Standalone Components**: Uses Angular standalone components (no NgModules)
- **Service Injection**: Uses `inject()` function for dependency injection
- **RxJS**: Leverages observables for reactive data flow
- **TypeScript**: Fully typed for better development experience

### Performance Considerations
- Data is processed in chunks to avoid blocking the UI thread
- Channel data is cached to minimize reprocessing
- Chart updates are debounced to prevent excessive redraws
- Memory cleanup is performed when channels are deselected

### Future Enhancements
- Full WebGL rendering support
- Real-time data streaming
- Advanced filtering and search
- Custom chart themes
- Data aggregation options
- Export to multiple formats (JSON, Excel)

## 📞 Support

For issues, questions, or contributions, please open an issue in the repository.

---

**Built with ❤️ using Angular and ECharts**
