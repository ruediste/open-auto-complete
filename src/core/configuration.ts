export interface OpenAutoCompleteConfiguration {
  apiBase: string;
  apiKey: string;
  logCompletionManager: boolean;
  logCompletionStop: boolean;
  prefixLength: number;
  suffixLength: number;
  matchLength: number;
  searchLength: number;
}

export class ConfigContainer {
  public config!: OpenAutoCompleteConfiguration;
}
