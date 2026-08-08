// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - reSID 主板外部滤波器参考进程
//
//   文件:       ResIdExternalFilterOracle.cpp
//
//   日期:       2026年08月08日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>

#include "extfilt.h"

int main()
{
    reSID::ExternalFilter filter;
    int input = 0;
    std::string command;
    while (std::cin >> command)
    {
        if (command == "RESET")
        {
            filter.reset();
            input = 0;
        }
        else if (command == "INPUT")
        {
            std::cin >> input;
            if (input < INT16_MIN || input > INT16_MAX)
            {
                throw std::out_of_range("INPUT must fit a signed 16-bit sample.");
            }
        }
        else if (command == "CLOCK")
        {
            unsigned int cycles;
            std::cin >> cycles;
            for (unsigned int cycle = 0; cycle < cycles; ++cycle)
            {
                filter.clock(static_cast<short>(input));
                std::cout << filter.output() << '\n';
            }
        }
        else
        {
            throw std::invalid_argument("Unknown external-filter oracle command: " + command);
        }

        if (!std::cin)
        {
            throw std::runtime_error("Incomplete external-filter oracle command: " + command);
        }
    }
}
