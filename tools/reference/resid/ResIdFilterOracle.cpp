// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - reSID 滤波器参考进程
//
//   文件:       ResIdFilterOracle.cpp
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>

#include "filter.h"

int main()
{
    reSID::Filter filter;
    filter.set_chip_model(reSID::MOS8580);
    filter.reset();

    int voice1 = 0;
    int voice2 = 0;
    int voice3 = 0;
    std::string command;
    while (std::cin >> command)
    {
        if (command == "RESET")
        {
            filter.reset();
        }
        else if (command == "MODEL")
        {
            unsigned int value;
            std::cin >> value;
            if (value == 6581)
            {
                filter.set_chip_model(reSID::MOS6581);
            }
            else if (value == 8580)
            {
                filter.set_chip_model(reSID::MOS8580);
            }
            else
            {
                throw std::out_of_range("MODEL must be 6581 or 8580.");
            }
        }
        else if (command == "CUTOFF")
        {
            unsigned int value;
            std::cin >> value;
            filter.writeFC_LO(static_cast<reSID::reg8>(value & 0x07));
            filter.writeFC_HI(static_cast<reSID::reg8>((value >> 3) & 0xff));
        }
        else if (command == "RESONANCE_ROUTING")
        {
            unsigned int value;
            std::cin >> value;
            filter.writeRES_FILT(static_cast<reSID::reg8>(value));
        }
        else if (command == "MODE_VOLUME")
        {
            unsigned int value;
            std::cin >> value;
            filter.writeMODE_VOL(static_cast<reSID::reg8>(value));
        }
        else if (command == "VOICES")
        {
            std::cin >> voice1 >> voice2 >> voice3;
        }
        else if (command == "EXTERNAL_INPUT")
        {
            int value;
            std::cin >> value;
            if (value < INT16_MIN || value > INT16_MAX)
            {
                throw std::out_of_range("EXTERNAL_INPUT must fit a signed 16-bit sample.");
            }
            filter.input(static_cast<short>(value));
        }
        else if (command == "CLOCK")
        {
            unsigned int cycles;
            std::cin >> cycles;
            for (unsigned int cycle = 0; cycle < cycles; ++cycle)
            {
                filter.clock(voice1, voice2, voice3);
                std::cout << filter.output() << '\n';
            }
        }
        else
        {
            throw std::invalid_argument("Unknown filter oracle command: " + command);
        }

        if (!std::cin)
        {
            throw std::runtime_error("Incomplete filter oracle command: " + command);
        }
    }
}
