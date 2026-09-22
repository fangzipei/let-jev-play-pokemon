/** OpenRouter Decisions API（alpha，POST /api/alpha/decisions）的题型与答案类型 */
/** 来源：https://openrouter.ai/openapi/openapi.yaml（DecisionsRequest / DecisionsResponse） */

export type CriteriaValue = string | Record<string, unknown> | unknown[] | null;

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria: {true: CriteriaValue; false: CriteriaValue};
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, CriteriaValue>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: CriteriaValue[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface ScoreAnswer {
  type: 'score';
  score: number;
  legend?: Record<string, string>;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface DecisionsUsage {
  cost?: number;
  input_tokens?: number;
  output_tokens?: number;
}

export interface DecisionsResponse {
  id?: string;
  model?: string;
  provider?: string;
  answers: Record<string, Answer>;
  usage: DecisionsUsage;
}
