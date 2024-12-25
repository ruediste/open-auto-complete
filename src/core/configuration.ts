export interface OpenAutoCompleteConfiguration {
  apiBase: string;
  apiKey: string;
  model: string;
  logCompletionManager: boolean;
  logCompletionStop: boolean;
  prefixLength: number;
  suffixLength: number;
  matchLength: number;
  searchLength: number;
  provider: "mistral" | "ollama";
}

export class ConfigContainer {
  public config!: OpenAutoCompleteConfiguration;
}
