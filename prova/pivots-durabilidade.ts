// Issue #446: `pivots` sobrevive a um processo que morre entre a
// REGISTRAÇÃO/progresso do stretch e sua escrita terminal — o teto de
// `MAX_ROUTE_PIVOTS_PER_RUN` deixa de ser contornável por crash.
export default {
  unit: ["tests/workflow-route-override.test.ts"],
};
