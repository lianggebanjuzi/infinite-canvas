// src/state/providers-state.ts
// 供应商列表、当前编辑的供应商 ID、已拉取的模型数据
export const providersState = {
    list: [] as Array<{
        id: string;
        name: string;
        type: string;
        short_name: string;
        enabled: boolean;
        api_key?: string;
        api_url?: string;
        use_proxy?: boolean;
        models?: Array<{ id: string; name: string; category?: string }>;
    }>,
    currentId: null as string | null,
    fetchedModels: null as Record<string, Array<{ id: string; name: string; category?: string }>> | null
};
