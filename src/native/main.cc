#include <iostream>
#include "gen/greet.rpc.h"
#include "rpc.h"

using google::protobuf::StringValue;
using mo::rpc::Callback;

// Placeholder native service kept until MoStats adds narrow macOS probes
// (for example disk statfs or temperature sensors) in later iterations. The
// MoBrowser native build requires at least one proto-backed service, so this
// sample stays registered but unused; the renderer no longer calls it.
class GreetServiceImpl : public GreetService {
 public:
  void SayHello(const Person* person, Callback<StringValue> done) override {
    StringValue response;
    response.set_value("Hello, " + person->name() + "!");
    std::move(done).Complete(response);
  }
};

void launch() {
  mo::rpc::RegisterService(new GreetServiceImpl());
}
