@echo off
title OWM Drive Setup
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr -useb https://raw.githubusercontent.com/capnkeith/one-world-montessori/main/bootstrap/first-run.ps1 | iex"
