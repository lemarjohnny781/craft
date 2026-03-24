import { createClient } from '@/lib/supabase/server';
import type { CustomizationConfig } from '@craft/types';

export interface CustomizationDraft {
    id: string;
    userId: string;
    templateId: string;
    customizationConfig: CustomizationConfig;
    createdAt: Date;
    updatedAt: Date;
}

export class CustomizationDraftService {
    /**
     * Save (create or overwrite) a customization draft for a user+template pair.
     * Only one draft per user per template is kept.
     */
    async saveDraft(
        userId: string,
        templateId: string,
        config: CustomizationConfig
    ): Promise<CustomizationDraft> {
        const supabase = createClient();

        // Verify the template exists and is active
        const { data: template, error: templateError } = await supabase
            .from('templates')
            .select('id')
            .eq('id', templateId)
            .eq('is_active', true)
            .single();

        if (templateError || !template) {
            throw new Error('Template not found');
        }

        const { data, error } = await supabase
            .from('customization_drafts')
            .upsert(
                {
                    user_id: userId,
                    template_id: templateId,
                    customization_config: config as any,
                    updated_at: new Date().toISOString(),
                },
                { onConflict: 'user_id,template_id' }
            )
            .select()
            .single();

        if (error) {
            throw new Error(`Failed to save draft: ${error.message}`);
        }

        return this.mapRow(data);
    }

    /**
     * Get the saved draft for a user+template pair, or null if none exists.
     */
    async getDraft(
        userId: string,
        templateId: string
    ): Promise<CustomizationDraft | null> {
        const supabase = createClient();

        const { data, error } = await supabase
            .from('customization_drafts')
            .select('*')
            .eq('user_id', userId)
            .eq('template_id', templateId)
            .single();

        if (error?.code === 'PGRST116') return null; // no rows
        if (error) throw new Error(`Failed to get draft: ${error.message}`);

        return data ? this.mapRow(data) : null;
    }

    private mapRow(row: any): CustomizationDraft {
        return {
            id: row.id,
            userId: row.user_id,
            templateId: row.template_id,
            customizationConfig: row.customization_config as CustomizationConfig,
            createdAt: new Date(row.created_at),
            updatedAt: new Date(row.updated_at),
        };
    }
}

export const customizationDraftService = new CustomizationDraftService();
