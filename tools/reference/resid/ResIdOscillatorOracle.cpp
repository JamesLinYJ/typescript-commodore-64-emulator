// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - reSID 振荡器参考程序
//
//   文件:       ResIdOscillatorOracle.cpp
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

#include <array>
#include <cstdlib>
#include <iostream>
#include <string>

#include "wave.h"

namespace {

constexpr unsigned int VOICE_COUNT = 3;

reSID::WaveformGenerator& require_voice(
    std::array<reSID::WaveformGenerator, VOICE_COUNT>& voices,
    unsigned int index) {
  if (index >= voices.size()) {
    std::cerr << "Invalid oscillator index: " << index << '\n';
    std::exit(7);
  }
  return voices[index];
}

}  // namespace

int main() {
  std::array<reSID::WaveformGenerator, VOICE_COUNT> voices;
  voices[0].set_sync_source(&voices[2]);
  voices[1].set_sync_source(&voices[0]);
  voices[2].set_sync_source(&voices[1]);

  std::string command;
  bool first_output = true;
  while (std::cin >> command) {
    unsigned int index = 0;
    unsigned int value = 0;
    if (command == "MODEL") {
      if (!(std::cin >> value)) return 2;
      const auto model = value == 6581 ? reSID::MOS6581 : reSID::MOS8580;
      for (auto& voice : voices) voice.set_chip_model(model);
    } else if (command == "FREQUENCY") {
      if (!(std::cin >> index >> value)) return 3;
      auto& voice = require_voice(voices, index);
      voice.writeFREQ_LO(value & 0xff);
      voice.writeFREQ_HI((value >> 8) & 0xff);
    } else if (command == "PULSE_WIDTH") {
      if (!(std::cin >> index >> value)) return 4;
      auto& voice = require_voice(voices, index);
      voice.writePW_LO(value & 0xff);
      voice.writePW_HI((value >> 8) & 0x0f);
    } else if (command == "CONTROL") {
      if (!(std::cin >> index >> value)) return 5;
      require_voice(voices, index).writeCONTROL_REG(value);
    } else if (command == "CLOCK") {
      if (!(std::cin >> value)) return 6;
      for (unsigned int cycle = 0; cycle < value; cycle += 1) {
        for (auto& voice : voices) voice.clock();
        for (auto& voice : voices) voice.synchronize();
        for (auto& voice : voices) voice.set_waveform_output();
        for (auto& voice : voices) {
          if (!first_output) std::cout << ' ';
          std::cout << voice.readOSC();
          first_output = false;
        }
      }
    } else if (command == "RESET") {
      for (auto& voice : voices) voice.reset();
    } else {
      std::cerr << "Unknown oracle command: " << command << '\n';
      return 8;
    }
  }

  std::cout << '\n';
  return 0;
}
