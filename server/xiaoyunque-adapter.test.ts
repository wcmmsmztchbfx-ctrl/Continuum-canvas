import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { XiaoYunqueAdapter } from './providers/xiaoyunque-adapter.ts'
import type { GenerationRequest } from '../src/contracts/generation.ts'
import { ProviderRequestRejectedError } from './providers/provider-adapter.ts'

async function tempDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'xyq-test-'))
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeVideoRequest(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    generationId: 'gen-xyq-1',
    canvasId: 'canvas-1',
    nodeId: 'node-1',
    providerId: 'xiaoyunque',
    model: 'seedance2.0_fast_vision',
    prompt: '赛博朋克城市夜景雨中飞行器穿梭',
    mediaType: 'video',
    channel: 'video',
    aspectRatio: '16:9',
    duration: 10,
    ...overrides,
  }
}

describe('XiaoYunqueAdapter', () => {
  it('authenticates and syncs Seedance 2.0 video model catalog', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        ret: '5',
        errmsg: '获取会话信息失败',
      }),
    )

    const stagingDir = await tempDirectory()
    try {
      const adapter = new XiaoYunqueAdapter({
        apiKey: 'ak-valid-test-key',
        baseUrl: 'https://xyq.jianying.com',
        fetcher,
        stagingDir,
      })

      await expect(adapter.testConnection()).resolves.toBeUndefined()

      const catalog = await adapter.syncCatalog()
      expect(catalog.providerId).toBe('xiaoyunque')
      expect(catalog.models.length).toBeGreaterThanOrEqual(4)
      const fastVision = catalog.models.find((m) => m.model === 'seedance2.0_fast_vision')
      expect(fastVision?.mediaType).toBe('video')
      expect(fastVision?.durationOptions).toContain(5)
      expect(fastVision?.aspectRatios).toContain('16:9')
      expect(fastVision?.aspectRatios).toContain('9:16')
      expect(catalog.models.some((m) => m.model === 'seedance2.0_vision')).toBe(true)
      expect(catalog.models.some((m) => m.model === 'Seedance_2.5')).toBe(true)
      expect(catalog.models.some((m) => m.model === 'seedream_5.0_pro')).toBe(true)
    } finally {
      await rm(stagingDir, { recursive: true, force: true })
    }
  })

  it('rejects with ProviderRequestRejectedError when AccessKey is invalid', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      jsonResponse({
        ret: '2',
        errmsg: '未查询到有效的Ak明细',
      }),
    )

    const stagingDir = await tempDirectory()
    try {
      const adapter = new XiaoYunqueAdapter({
        apiKey: 'ak-invalid-key',
        baseUrl: 'https://xyq.jianying.com',
        fetcher,
        stagingDir,
      })

      await expect(adapter.testConnection()).rejects.toThrow(ProviderRequestRejectedError)
      await expect(adapter.testConnection()).rejects.toThrow('未查询到有效的Ak明细')
    } finally {
      await rm(stagingDir, { recursive: true, force: true })
    }
  })

  it('creates video generation request with prompt and returns composite taskId', async () => {
    let capturedUrl = ''
    let capturedBody: any
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      capturedUrl = String(url)
      if (init?.body) {
        capturedBody = JSON.parse(init.body as string)
      }
      return jsonResponse({
        ret: '0',
        errmsg: '',
        data: {
          run: {
            thread_id: 'thread-xyz-123',
            run_id: 'run-abc-456',
            state: 1,
          },
        },
      })
    })

    const stagingDir = await tempDirectory()
    try {
      const adapter = new XiaoYunqueAdapter({
        apiKey: 'ak-valid-key',
        baseUrl: 'https://xyq.jianying.com',
        fetcher,
        stagingDir,
      })

      const taskId = await adapter.createGeneration(makeVideoRequest(), [])
      expect(taskId).toBe('thread-xyz-123:run-abc-456')
      expect(capturedUrl).toContain('/api/biz/v1/skill/submit_run')
      expect(capturedBody).toEqual({
        message: '赛博朋克城市夜景雨中飞行器穿梭',
        general_agent_settings: {
          video_model: 'seedance2.0_fast_vision',
          aspect_ratio: '16:9',
          duration_start: 10,
          duration_end: 10,
        },
      })
    } finally {
      await rm(stagingDir, { recursive: true, force: true })
    }
  })

  it('polls status: running in queue -> completed with video URL', async () => {
    const stagingDir = await tempDirectory()
    try {
      // 1. Running state response
      const runningResponse = jsonResponse({
        ret: '0',
        errmsg: '',
        data: {
          thread: {
            run_list: [
              {
                run_id: 'run-456',
                thread_id: 'thread-123',
                state: 2,
                entry_list: [],
                RunQueueInfo: {
                  task_status: 2,
                  expected_wait_time_seconds: 60,
                },
              },
            ],
          },
        },
      })

      // 2. Completed state response with video URL in tool_resp
      const completedResponse = jsonResponse({
        ret: '0',
        errmsg: '',
        data: {
          thread: {
            run_list: [
              {
                run_id: 'run-456',
                thread_id: 'thread-123',
                state: 3,
                completed_at: 1788764000,
                entry_list: [
                  {
                    type: 1,
                    tool_info_list: [
                      {
                        tool_name: 'sandbox_generate_video',
                        tool_resp: JSON.stringify({
                          Status: 'succeeded',
                          Video: {
                            URL: 'https://v11-xyq-video.jianying.com/test-video.mp4',
                            PreviewUrl: 'https://v5-xyq-video.jianying.com/test-preview.mp4',
                            Width: 1280,
                            Height: 720,
                          },
                        }),
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      })

      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(runningResponse)
        .mockResolvedValueOnce(completedResponse)

      const adapter = new XiaoYunqueAdapter({
        apiKey: 'ak-valid-key',
        baseUrl: 'https://xyq.jianying.com',
        fetcher,
        stagingDir,
      })

      const runningStatus = await adapter.getGenerationDetail('thread-123:run-456')
      expect(runningStatus.status).toBe(1) // STATUS_RUNNING
      expect(runningStatus.outputs).toBeUndefined()

      const completedStatus = await adapter.getGenerationDetail('thread-123:run-456')
      expect(completedStatus.status).toBe(3) // STATUS_COMPLETE
      expect(completedStatus.progress).toBe(100)
      expect(completedStatus.outputs).toEqual(['https://v11-xyq-video.jianying.com/test-video.mp4'])
    } finally {
      await rm(stagingDir, { recursive: true, force: true })
    }
  })

  it('polls status: handles failure reason correctly', async () => {
    const stagingDir = await tempDirectory()
    try {
      const failedResponse = jsonResponse({
        ret: '0',
        errmsg: '',
        data: {
          thread: {
            run_list: [
              {
                run_id: 'run-456',
                thread_id: 'thread-123',
                state: 4,
                fail_reason: {
                  code: '1001',
                  message: '敏感内容拦截，无法生成该视频',
                },
              },
            ],
          },
        },
      })

      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(failedResponse)

      const adapter = new XiaoYunqueAdapter({
        apiKey: 'ak-valid-key',
        baseUrl: 'https://xyq.jianying.com',
        fetcher,
        stagingDir,
      })

      const status = await adapter.getGenerationDetail('thread-123:run-456')
      expect(status.status).toBe(4) // STATUS_FAILED
      expect(status.errorMessage).toBe('敏感内容拦截，无法生成该视频')
    } finally {
      await rm(stagingDir, { recursive: true, force: true })
    }
  })

  it('extracts video URL from artifact content data and tool_info_list as returned by production XYQ API', async () => {
    const stagingDir = await tempDirectory()
    try {
      const realWorldArtifactResponse = jsonResponse({
        ret: '0',
        errmsg: '',
        data: {
          thread: {
            run_list: [
              {
                run_id: 'skill_3c430ec9-358e-46dc-ada8-726a363d617b',
                thread_id: 'skill_ab7c9ded-0fd2-4c87-a718-ca686b336104',
                state: 3,
                completed_at: 1788764039,
                fail_reason: null,
                entry_list: [
                  {
                    type: 2,
                    artifact: {
                      artifact_id: '6319627200524',
                      name: 'shot_01.mp4',
                      content: [
                        {
                          type: 'data',
                          sub_type: 'biz/x_data_video',
                          data: JSON.stringify({
                            video: {
                              url: 'https://v11-xyq-video.jianying.com/real-video.mp4',
                              download_url: 'https://v11-xyq-video.jianying.com/real-video-download.mp4',
                              cover_url: 'https://p9-sign.douyinpic.com/real-cover.jpg',
                            },
                          }),
                        },
                      ],
                      tool_info_list: [
                        {
                          tool_name: 'sandbox_generate_video',
                          tool_resp: JSON.stringify({
                            Status: 'succeeded',
                            Video: {
                              URL: 'https://v11-xyq-video.jianying.com/real-video-tool.mp4',
                              CoverUrl: 'https://p9-sign.douyinpic.com/real-cover.jpg',
                            },
                          }),
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
      })

      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(realWorldArtifactResponse)

      const adapter = new XiaoYunqueAdapter({
        apiKey: 'ak-valid-key',
        baseUrl: 'https://xyq.jianying.com',
        fetcher,
        stagingDir,
      })

      const status = await adapter.getGenerationDetail('skill_ab7c9ded-0fd2-4c87-a718-ca686b336104:skill_3c430ec9-358e-46dc-ada8-726a363d617b')
      expect(status.status).toBe(3) // STATUS_COMPLETE
      expect(status.progress).toBe(100)
      expect(status.outputs).toEqual(['https://v11-xyq-video.jianying.com/real-video-download.mp4'])
    } finally {
      await rm(stagingDir, { recursive: true, force: true })
    }
  })

  it('handles pure conversational text without failing when no video is generated', async () => {
    const stagingDir = await tempDirectory()
    try {
      const chatOnlyResponse = jsonResponse({
        ret: '0',
        errmsg: '',
        data: {
          thread: {
            run_list: [
              {
                run_id: 'run-chat-123',
                thread_id: 'thread-chat-456',
                state: 3,
                completed_at: 1788765000,
                entry_list: [
                  {
                    type: 1,
                    message: {
                      role: 'assistant',
                      content: '你好！有什么想做的，随时说。',
                    },
                  },
                ],
              },
            ],
          },
        },
      })

      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(chatOnlyResponse)
      const adapter = new XiaoYunqueAdapter({
        apiKey: 'ak-valid-key',
        baseUrl: 'https://xyq.jianying.com',
        fetcher,
        stagingDir,
      })

      const status = await adapter.getGenerationDetail('thread-chat-456:run-chat-123')
      expect(status.status).toBe(3) // STATUS_COMPLETE
      expect(status.outputs).toEqual([])
      expect(status.errorMessage).toBe('你好！有什么想做的，随时说。')
    } finally {
      await rm(stagingDir, { recursive: true, force: true })
    }
  })

  it('supports direct chat method returning assistant reply and thread context', async () => {
    const stagingDir = await tempDirectory()
    try {
      let callCount = 0
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
        callCount += 1
        if (String(url).includes('/submit_run')) {
          return jsonResponse({
            ret: '0',
            errmsg: '',
            data: {
              run: {
                thread_id: 'th-hello-1',
                run_id: 'run-hello-2',
                state: 1,
              },
            },
          })
        }
        return jsonResponse({
          ret: '0',
          errmsg: '',
          data: {
            thread: {
              run_list: [
                {
                  run_id: 'run-hello-2',
                  thread_id: 'th-hello-1',
                  state: 3,
                  completed_at: 1788765000,
                  entry_list: [
                    {
                      message: {
                        role: 'assistant',
                        content: '你好！我是AI导演，请告诉我您的创意需求。',
                        reasoning_content: '分析用户输入，礼貌问候并引导创意',
                      },
                    },
                  ],
                },
              ],
            },
          },
        })
      })

      const adapter = new XiaoYunqueAdapter({
        apiKey: 'ak-valid-key',
        baseUrl: 'https://xyq.jianying.com',
        fetcher,
        stagingDir,
      })

      const result = await adapter.chat('你好')
      expect(result.reply).toBe('你好！我是AI导演，请告诉我您的创意需求。')
      expect(result.thinking).toBe('分析用户输入，礼貌问候并引导创意')
      expect(result.threadId).toBe('th-hello-1')
      expect(result.runId).toBe('run-hello-2')
    } finally {
      await rm(stagingDir, { recursive: true, force: true })
    }
  })

  it('injects general_agent_settings into chat request when preferences are supplied', async () => {
    const stagingDir = await tempDirectory()
    try {
      let capturedBody: any
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
        if (String(url).includes('/submit_run')) {
          capturedBody = JSON.parse(init?.body as string)
          return jsonResponse({
            ret: '0',
            errmsg: '',
            data: {
              run: {
                thread_id: 'th-pref-1',
                run_id: 'run-pref-2',
                state: 1,
              },
            },
          })
        }
        return jsonResponse({
          ret: '0',
          errmsg: '',
          data: {
            thread: {
              run_list: [
                {
                  run_id: 'run-pref-2',
                  thread_id: 'th-pref-1',
                  state: 3,
                  completed_at: 1788765000,
                  entry_list: [
                    {
                      message: {
                        role: 'assistant',
                        content: '已为您应用 Seedance 2.0 VIP 效果无损规格进行视频创意推演。',
                      },
                    },
                  ],
                },
              ],
            },
          },
        })
      })

      const adapter = new XiaoYunqueAdapter({
        apiKey: 'ak-valid-key',
        baseUrl: 'https://xyq.jianying.com',
        fetcher,
        stagingDir,
      })

      const result = await adapter.chat('创作中秋短片', undefined, undefined, undefined, {
        model: 'Seedance 2.0 Fast VIP',
        aspectRatio: '9:16',
        resolution: '720p',
        duration: 10,
      })

      expect(result.reply).toBe('已为您应用 Seedance 2.0 VIP 效果无损规格进行视频创意推演。')
      expect(capturedBody).toEqual({
        message: '创作中秋短片',
        general_agent_settings: {
          video_model: 'seedance2.0_fast_vision',
          aspect_ratio: '9:16',
          resolution: '720p',
          duration_start: 10,
          duration_end: 10,
        },
      })
    } finally {
      await rm(stagingDir, { recursive: true, force: true })
    }
  })

  it('extracts imageUrl and injects image_model when image preferenceMode is used', async () => {
    const stagingDir = await tempDirectory()
    try {
      let capturedBody: any
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
        if (String(url).includes('/submit_run')) {
          capturedBody = JSON.parse(init?.body as string)
          return jsonResponse({
            ret: '0',
            errmsg: '',
            data: {
              run: {
                thread_id: 'th-img-1',
                run_id: 'run-img-2',
                state: 1,
              },
            },
          })
        }
        return jsonResponse({
          ret: '0',
          errmsg: '',
          data: {
            thread: {
              run_list: [
                {
                  run_id: 'run-img-2',
                  thread_id: 'th-img-1',
                  state: 3,
                  completed_at: 1788766000,
                  entry_list: [
                    {
                      message: {
                        role: 'assistant',
                        content: '红色版包装已生成，保持了原图的卡通角色IP。',
                      },
                      artifact: {
                        type: 'image',
                        download_url: 'https://p9-sign.douyinpic.com/duck-neck-red.png',
                      },
                    },
                  ],
                },
              ],
            },
          },
        })
      })

      const adapter = new XiaoYunqueAdapter({
        apiKey: 'ak-valid-key',
        baseUrl: 'https://xyq.jianying.com',
        fetcher,
        stagingDir,
      })

      const result = await adapter.chat('参考这个图生成一个红色的包装', undefined, undefined, undefined, {
        preferenceMode: 'image',
        imageModel: 'seedream_5.0_pro',
        aspectRatio: '3:4',
        resolution: '2K',
      })

      expect(result.reply).toBe('红色版包装已生成，保持了原图的卡通角色IP。')
      expect(result.imageUrl).toBe('https://p9-sign.douyinpic.com/duck-neck-red.png')
      expect(result.videoUrl).toBeUndefined()
      expect(capturedBody).toEqual({
        message: '参考这个图生成一个红色的包装',
        general_agent_settings: {
          image_model: 'seedream_5.0_pro',
          aspect_ratio: '3:4',
          resolution: '2K',
        },
      })
    } finally {
      await rm(stagingDir, { recursive: true, force: true })
    }
  })

  it('extracts aspectRatio, width, and height from tool responses and artifact metadata', async () => {
    const stagingDir = await tempDirectory()
    try {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
        if (String(url).includes('/submit_run')) {
          return jsonResponse({
            ret: '0',
            errmsg: '',
            data: {
              run: {
                thread_id: 'th-pack-1',
                run_id: 'run-pack-1',
                state: 1,
              },
            },
          })
        }
        return jsonResponse({
          ret: '0',
          errmsg: '',
          data: {
            thread: {
              run_list: [
                {
                  run_id: 'run-pack-1',
                  thread_id: 'th-pack-1',
                  state: 3,
                  completed_at: 1788766000,
                  entry_list: [
                    {
                      message: {
                        role: 'assistant',
                        content: [
                          {
                            type: 'data',
                            sub_type: 'biz/x_artifact_slots_part',
                            data: JSON.stringify({
                              slots: [{ artifact_id: 'art-1', ratio: '3:4', type: 'image' }],
                            }),
                          },
                        ],
                      },
                      artifact: {
                        type: 'image',
                        download_url: 'https://p9-sign.douyinpic.com/packaging.png',
                        content: [
                          {
                            type: 'data',
                            sub_type: 'biz/x_data_image',
                            data: JSON.stringify({
                              image: {
                                metadata: { width: 864, height: 1152 },
                                url: 'https://p9-sign.douyinpic.com/packaging.png',
                              },
                            }),
                          },
                        ],
                      },
                    },
                  ],
                },
              ],
            },
          },
        })
      })

      const adapter = new XiaoYunqueAdapter({
        apiKey: 'ak-valid-key',
        baseUrl: 'https://xyq.jianying.com',
        fetcher,
        stagingDir,
      })

      const result = await adapter.chat('生成酸辣粉丝包装', undefined, undefined, undefined, {
        preferenceMode: 'image',
      })

      expect(result.imageUrl).toBe('https://p9-sign.douyinpic.com/packaging.png')
      expect(result.reply).not.toContain('artifact_id')
      expect(result.aspectRatio).toBe('3:4')
      expect(result.width).toBe(864)
      expect(result.height).toBe(1152)

      const pollResult = await adapter.checkRunStatus('th-pack-1', 'run-pack-1', 'image')
      expect(pollResult.imageUrl).toBe('https://p9-sign.douyinpic.com/packaging.png')
      expect(pollResult.aspectRatio).toBe('3:4')
      expect(pollResult.width).toBe(864)
      expect(pollResult.height).toBe(1152)
    } finally {
      await rm(stagingDir, { recursive: true, force: true })
    }
  })

  it('preserves every video returned by one run and exposes observable execution steps', async () => {
    const stagingDir = await tempDirectory()
    try {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
        if (String(url).includes('/submit_run')) {
          return jsonResponse({
            ret: '0',
            data: { run: { thread_id: 'th-multi', run_id: 'run-multi', state: 1 } },
          })
        }
        return jsonResponse({
          ret: '0',
          data: {
            thread: {
              run_list: [{
                run_id: 'run-multi',
                state: 3,
                completed_at: 1788767000,
                entry_list: [{
                  message: {
                    role: 'assistant',
                    content: '两个视频单元均已完成。',
                    reasoning_content: '核对两个单元的时间轴和参考素材。',
                  },
                  tool_info_list: [{
                    tool_name: 'sandbox_generate_video',
                    tool_resp: JSON.stringify({
                      VideoInfoList: [
                        { VideoURL: 'https://example.com/unit-1.mp4' },
                        { VideoURL: 'https://example.com/unit-2.mp4' },
                      ],
                    }),
                  }],
                }],
              }],
            },
          },
        })
      })

      const adapter = new XiaoYunqueAdapter({
        apiKey: 'ak-valid-key',
        baseUrl: 'https://xyq.jianying.com',
        fetcher,
        stagingDir,
      })

      const result = await adapter.chat('并行生成两个视频单元')
      expect(result.videoUrl).toBe('https://example.com/unit-1.mp4')
      expect(result.videoUrls).toEqual([
        'https://example.com/unit-1.mp4',
        'https://example.com/unit-2.mp4',
      ])
      expect(result.executionSteps?.map((step) => step.title)).toEqual(expect.arrayContaining([
        '分析创作要求与参考素材',
        '执行 sandbox_generate_video',
        '完成视频产物 1',
        '完成视频产物 2',
      ]))
    } finally {
      await rm(stagingDir, { recursive: true, force: true })
    }
  })

  it('keeps polling when a running task has only partial text and artifacts', async () => {
    const stagingDir = await tempDirectory()
    try {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
        ret: '0',
        data: {
          thread: {
            run_list: [{
              run_id: 'run-partial',
              state: 2,
              entry_list: [{
                message: { role: 'assistant', content: '第一张已完成，继续生成其余图片。' },
                tool_info_list: [{
                  tool_name: 'sandbox_generate_image',
                  tool_resp: {
                    ImageInfoList: [{ ImageURL: 'https://example.com/partial-1.png' }],
                  },
                }],
              }],
            }],
          },
        },
      }))

      const adapter = new XiaoYunqueAdapter({
        apiKey: 'ak-valid-key',
        baseUrl: 'https://xyq.jianying.com',
        fetcher,
        stagingDir,
      })

      const result = await adapter.checkRunStatus('th-partial', 'run-partial', 'image')
      expect(result.pending).toBe(true)
      expect(result.imageUrls).toEqual(['https://example.com/partial-1.png'])
      expect(result.executionSteps?.some((step) => step.status === 'running')).toBe(true)
    } finally {
      await rm(stagingDir, { recursive: true, force: true })
    }
  })

  it('returns a running questionnaire as an answerable turn and keeps detailed progress', async () => {
    const stagingDir = await tempDirectory()
    try {
      const questionnaire = {
        questionnaire_id: 'q-video-strategy',
        title: '选择视频生成策略',
        questions: [{
          id: 'strategy',
          title: '请选择下一步',
          options: [
            { id: 'parallel', label: '并行生成', value: 'parallel' },
            { id: 'serial', label: '逐段生成', value: 'serial' },
          ],
        }],
      }
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
        ret: '0',
        data: {
          thread: {
            run_list: [{
              run_id: 'run-questionnaire',
              state: 2,
              entry_list: [
                {
                  message: {
                    role: 'assistant',
                    content: '已读取三张角色参考图并完成分镜规划。',
                    reasoning_content: '核对人物一致性与两段视频的承接关系。',
                  },
                },
                {
                  message: {
                    role: 'assistant',
                    content: [{
                      type: 'data',
                      sub_type: 'biz/x_data_questionnaire',
                      data: JSON.stringify(questionnaire),
                    }],
                  },
                },
              ],
            }],
          },
        },
      }))

      const adapter = new XiaoYunqueAdapter({
        apiKey: 'ak-valid-key',
        baseUrl: 'https://xyq.jianying.com',
        fetcher,
        stagingDir,
      })
      const result = await adapter.checkRunStatus('th-questionnaire', 'run-questionnaire', 'video')

      expect(result.pending).toBe(false)
      expect(result.reply).toContain('questionnaire_id')
      expect(result.reply).toContain('选择视频生成策略')
      expect(result.thinking).toContain('核对人物一致性')
      expect(result.thinking).toContain('已读取三张角色参考图')
    } finally {
      await rm(stagingDir, { recursive: true, force: true })
    }
  })
})
