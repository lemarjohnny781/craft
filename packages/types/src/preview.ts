import { CustomizationConfig } from './customization';
import { StellarMockData } from './stellar';

export interface PreviewPayload {
    customization: CustomizationConfig;
    mockData: StellarMockData;
    timestamp: string;
}

export interface PreviewAsset {
    url: string;
    type: 'image' | 'font' | 'icon';
}

export interface PreviewData {
    html: string;
    css: string;
    assets: PreviewAsset[];
    mockData: StellarMockData;
}
export interface PreviewUpdate {
    changes: Partial<CustomizationConfig>;
    changedFields: string[];
    requiresMockDataRefresh: boolean;
}

export interface PreviewUpdatePayload {
    customization: CustomizationConfig;
    mockData?: StellarMockData;
    changedFields: string[];
    timestamp: string;
}
