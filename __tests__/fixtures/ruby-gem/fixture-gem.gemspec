require_relative "lib/fixture/gem/version"

Gem::Specification.new do |spec|
  spec.name = "fixture-gem"
  spec.version = Fixture::Gem::VERSION
  spec.summary = "Fixture for the detect-project e2e tests"
  spec.authors = ["detect-project"]
  spec.files = []
end
