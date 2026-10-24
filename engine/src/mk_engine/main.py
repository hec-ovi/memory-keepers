"""Deployment entry point: uvicorn mk_engine.main:app"""
from .app import create_app

app = create_app()
