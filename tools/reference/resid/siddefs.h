// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - reSID 参考编译配置
//
//   文件:       siddefs.h
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

#ifndef TYPESCRIPT_C64_RESID_SIDDEFS_H
#define TYPESCRIPT_C64_RESID_SIDDEFS_H

#define RESID_INLINING 0
#define RESID_INLINE
#define RESID_BRANCH_HINTS 1
#define NEW_8580_FILTER 1
#define HAVE_BOOL 1
#define HAVE_BUILTIN_EXPECT 1
#define HAVE_LOG1P 1

#define likely(value) __builtin_expect(!!(value), 1)
#define unlikely(value) __builtin_expect(!!(value), 0)

namespace reSID {

using reg4 = unsigned int;
using reg8 = unsigned int;
using reg12 = unsigned int;
using reg16 = unsigned int;
using reg24 = unsigned int;
using cycle_count = int;
using short_point = short[2];
using double_point = double[2];

enum chip_model { MOS6581, MOS8580 };

enum sampling_method {
  SAMPLE_FAST,
  SAMPLE_INTERPOLATE,
  SAMPLE_RESAMPLE,
  SAMPLE_RESAMPLE_FASTMEM,
};

}  // namespace reSID

#endif
