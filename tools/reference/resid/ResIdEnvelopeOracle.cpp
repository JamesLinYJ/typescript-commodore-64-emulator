// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - reSID 包络参考程序
//
//   文件:       ResIdEnvelopeOracle.cpp
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

#include <iostream>
#include <string>

#include "envelope.h"

int main() {
  reSID::EnvelopeGenerator envelope;
  std::string command;
  bool firstOutput = true;

  while (std::cin >> command) {
    unsigned int value = 0;
    if (command == "ATTACK_DECAY") {
      if (!(std::cin >> value)) return 2;
      envelope.writeATTACK_DECAY(value);
    } else if (command == "SUSTAIN_RELEASE") {
      if (!(std::cin >> value)) return 3;
      envelope.writeSUSTAIN_RELEASE(value);
    } else if (command == "CONTROL") {
      if (!(std::cin >> value)) return 4;
      envelope.writeCONTROL_REG(value);
    } else if (command == "CLOCK") {
      if (!(std::cin >> value)) return 5;
      for (unsigned int cycle = 0; cycle < value; cycle += 1) {
        envelope.clock();
        if (!firstOutput) std::cout << ' ';
        std::cout << envelope.readENV();
        firstOutput = false;
      }
    } else if (command == "RESET") {
      envelope.reset();
    } else {
      std::cerr << "Unknown oracle command: " << command << '\n';
      return 6;
    }
  }

  std::cout << '\n';
  return 0;
}
