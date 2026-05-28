#include <iostream>
#include "gen/greet.rpc.h"
#include "rpc.h"

using google::protobuf::StringValue;
using mo::rpc::Callback;

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
