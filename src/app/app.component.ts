import { CommonModule, isPlatformBrowser } from '@angular/common';
import { Component, PLATFORM_ID, inject } from '@angular/core';
import { LogisticsMapComponent } from './logistics/logistics-map.component';
import { LogisticsGridComponent } from './logistics/logistics-grid.component';
import { LogisticsDataService } from './logistics/logistics-data.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, LogisticsMapComponent, LogisticsGridComponent],
  template: `
    <div class="dashboard">
      <!-- Wijmo / OpenLayers + *ngIf="isBrowser" differ from SSR; skip hydration for these subtrees -->
      <div class="map-panel">
        <app-logistics-map ngSkipHydration></app-logistics-map>
      </div>
      <div class="grid-panel">
        <app-logistics-grid ngSkipHydration></app-logistics-grid>
      </div>
    </div>
  `,
  styles: [`
    .dashboard {
      display: flex;
      flex-direction: column;
      height: 100vh;
      width: 100%;
      max-width: 100%;
      overflow: hidden;
      box-sizing: border-box;
      background: #dfe8f0;
    }
    .map-panel {
      box-sizing: border-box;
      flex: 0 0 42%;
      min-height: 180px;
      width: 100%;
      min-width: 0;
      position: relative;
      display: flex;
      flex-direction: column;
      border-bottom: 1px solid #c5d0dc;
    }
    .map-panel app-logistics-map {
      flex: 1 1 auto;
      min-height: 0;
      min-width: 0;
    }
    .grid-panel {
      box-sizing: border-box;
      flex: 1 1 58%;
      min-height: 0;
      min-width: 0;
      display: flex;
      flex-direction: column;
      background: #fff;
    }
    .grid-panel app-logistics-grid {
      flex: 1 1 auto;
      min-height: 0;
      min-width: 0;
    }
  `]
})
export class AppComponent {
  title = 'angularwijmo-wasm';

  private readonly dataService = inject(LogisticsDataService);
  private readonly platformId = inject(PLATFORM_ID);

  constructor() {
    if (isPlatformBrowser(this.platformId)) {
      this.dataService.loadData();
    }
  }
}
