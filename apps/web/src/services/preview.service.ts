import type { CustomizationConfig, PreviewPayload, StellarMockData, StellarAsset } from '@craft/types';

/**
 * PreviewService
 * 
 * Converts customization state into a renderable preview payload.
 * Generates deterministic mock Stellar data for iframe preview rendering.
 */
export class PreviewService {
    /**
     * Generate a preview payload from customization config.
     * Returns a deterministic payload with mock Stellar context.
     */
    generatePreview(customization: CustomizationConfig): PreviewPayload {
        const mockData = this.generateMockData(customization);

        return {
            customization,
            mockData,
            timestamp: new Date().toISOString(),
        };
    }
    /**
     * Update preview with partial customization changes.
     * Detects changed fields and only regenerates mock data if network config changed.
     * Returns minimal update payload for efficient iframe updates.
     */
    updatePreview(
        currentCustomization: CustomizationConfig,
        changes: Partial<CustomizationConfig>
    ): { customization: CustomizationConfig; mockData?: StellarMockData; changedFields: string[]; timestamp: string } {
        // Merge changes into current config
        const updatedCustomization = this.mergeCustomization(currentCustomization, changes);

        // Detect which fields changed
        const changedFields = this.detectChangedFields(currentCustomization, changes);

        // Determine if mock data needs refresh (network config changed)
        const requiresMockDataRefresh = this.requiresMockDataRefresh(changedFields);

        const payload: any = {
            customization: updatedCustomization,
            changedFields,
            timestamp: new Date().toISOString(),
        };

        // Only regenerate mock data if network config changed
        if (requiresMockDataRefresh) {
            payload.mockData = this.generateMockData(updatedCustomization);
        }

        return payload;
    }

    /**
     * Deep merge partial changes into current customization.
     */
    private mergeCustomization(
        current: CustomizationConfig,
        changes: Partial<CustomizationConfig>
    ): CustomizationConfig {
        return {
            branding: { ...current.branding, ...(changes.branding ?? {}) },
            features: { ...current.features, ...(changes.features ?? {}) },
            stellar: { ...current.stellar, ...(changes.stellar ?? {}) },
        };
    }

    /**
     * Detect which fields changed by comparing current and changes.
     * Returns array of dot-notation field paths (e.g., "branding.appName").
     */
    private detectChangedFields(
        current: CustomizationConfig,
        changes: Partial<CustomizationConfig>
    ): string[] {
        const fields: string[] = [];

        // Check branding changes
        if (changes.branding) {
            Object.keys(changes.branding).forEach((key) => {
                const currentVal = (current.branding as any)[key];
                const changeVal = (changes.branding as any)[key];
                if (currentVal !== changeVal) {
                    fields.push(`branding.${key}`);
                }
            });
        }

        // Check feature changes
        if (changes.features) {
            Object.keys(changes.features).forEach((key) => {
                const currentVal = (current.features as any)[key];
                const changeVal = (changes.features as any)[key];
                if (currentVal !== changeVal) {
                    fields.push(`features.${key}`);
                }
            });
        }

        // Check stellar changes
        if (changes.stellar) {
            Object.keys(changes.stellar).forEach((key) => {
                const currentVal = (current.stellar as any)[key];
                const changeVal = (changes.stellar as any)[key];
                if (currentVal !== changeVal) {
                    fields.push(`stellar.${key}`);
                }
            });
        }

        return fields;
    }

    /**
     * Determine if mock data needs to be regenerated.
     * Only network changes require mock data refresh.
     */
    private requiresMockDataRefresh(changedFields: string[]): boolean {
        return changedFields.some((field) => field.startsWith('stellar.network'));
    }

    /**
     * Generate deterministic mock Stellar data based on network configuration.
     * Mock data varies by network (mainnet vs testnet) for realistic previews.
     */
    private generateMockData(config: CustomizationConfig): StellarMockData {
        const { network } = config.stellar;
        const isMainnet = network === 'mainnet';

        // Generate mock assets based on network
        const xlmAsset: StellarAsset = {
            code: 'XLM',
            issuer: '',
            type: 'native',
        };

        const usdcAsset: StellarAsset = {
            code: 'USDC',
            issuer: isMainnet
                ? 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
                : 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
            type: 'credit_alphanum4',
        };

        // Generate mock transactions
        const now = new Date();
        const transactions = [
            {
                id: this.generateMockTxId(1),
                type: 'payment',
                amount: '100.0000000',
                asset: xlmAsset,
                timestamp: new Date(now.getTime() - 3600000), // 1 hour ago
            },
            {
                id: this.generateMockTxId(2),
                type: 'swap',
                amount: '50.0000000',
                asset: usdcAsset,
                timestamp: new Date(now.getTime() - 7200000), // 2 hours ago
            },
            {
                id: this.generateMockTxId(3),
                type: 'payment',
                amount: '25.5000000',
                asset: xlmAsset,
                timestamp: new Date(now.getTime() - 86400000), // 1 day ago
            },
        ];

        // Generate mock asset prices (different for mainnet vs testnet)
        const assetPrices = isMainnet
            ? {
                  XLM: 0.12,
                  USDC: 1.0,
                  BTC: 45000.0,
                  ETH: 3000.0,
              }
            : {
                  XLM: 0.10,
                  USDC: 1.0,
                  BTC: 40000.0,
                  ETH: 2500.0,
              };

        return {
            accountBalance: isMainnet ? '10000.0000000' : '5000.0000000',
            recentTransactions: transactions,
            assetPrices,
        };
    }

    /**
     * Generate a deterministic mock transaction ID.
     * Uses a simple pattern for preview consistency.
     */
    private generateMockTxId(index: number): string {
        const base = 'preview';
        const padded = index.toString().padStart(4, '0');
        return `${base}${padded}${'a'.repeat(60)}`;
    }
}

export const previewService = new PreviewService();
