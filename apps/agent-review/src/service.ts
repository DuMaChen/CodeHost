import {
  runAgentReview,
  type AgentProvider,
} from "@platform/agent";
import {
  REVIEW_INPUT_BYTES,
  REVIEW_REPORT_BYTES,
} from "./config.js";
import type { ReviewRequest, ReviewResponse } from "./protocol.js";

export class AgentReviewService {
  constructor(private readonly provider: AgentProvider) {}

  async review(request: ReviewRequest): Promise<ReviewResponse> {
    const result = await runAgentReview(this.provider, request.reviewInput, {
      maxInputBytes: REVIEW_INPUT_BYTES,
      maxReportBytes: REVIEW_REPORT_BYTES,
    });

    return {
      runId: request.runId,
      attempt: request.attempt,
      headSha: request.headSha,
      inputHash: request.inputHash,
      result,
    };
  }
}
