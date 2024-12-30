export interface OpenAutoCompleteConfiguration {
  apiBase: string;
  apiKey: string;
  model: string;
  enabled: boolean;
  logCompletionManager: boolean;
  logCompletionStop: boolean;
  prefixLength: number;
  suffixLength: number;
  matchLength: number;
  searchLength: number;
  provider: "mistral" | "ollama" | "openai" | "simple";
}

export class ConfigContainer {
  public config!: OpenAutoCompleteConfiguration;
}
