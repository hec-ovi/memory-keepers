class ModelsError(Exception):
    def __init__(self, message: str):
        self.code = "PROVIDER_UNAVAILABLE"
        super().__init__(message)
