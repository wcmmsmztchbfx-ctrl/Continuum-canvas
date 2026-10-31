# video-generation@1

Read generation_config for video models and supported durations/aspect ratios. Create a video target and call request_generation with that node ID, optional duration and explicitly intended image referenceIds. Use existing runtime validation. Unsupported settings must be clarified. Stable request IDs and the same stop/undo rules apply to video. Wait for actual asset completion; do not infer success from provider acceptance.
